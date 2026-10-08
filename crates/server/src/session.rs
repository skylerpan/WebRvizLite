//! One WebSocket connection: a reader task (control messages) and a writer
//! task (hello, topics, clock, errors, data frames).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use bytes::{BufMut, BytesMut};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Notify, broadcast, mpsc};
use webrvizlite_core::protocol::{ClientMessage, ServerMessage, SubscriptionId, TopicInfo};
use webrvizlite_core::wire::{self, FrameHeader};

use crate::AppState;
use crate::hub::{Key, Subscription};

const CLOCK_PERIOD: Duration = Duration::from_millis(100);

pub async fn run(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let wake = Arc::new(Notify::new());
    let (ctl_tx, mut ctl_rx) = mpsc::channel::<ServerMessage>(64);
    let subs: Arc<Mutex<HashMap<SubscriptionId, Subscription>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let mut topics_rx = state.topics_tx.subscribe();
    let session_id = state.next_session_id();
    tracing::info!(session_id, "websocket connected");

    // ---- writer -------------------------------------------------------
    let hub = state.hub.clone();
    let writer_subs = subs.clone();
    let writer_wake = wake.clone();
    let hello = state.hello();
    let initial_topics = state.current_topics();
    let writer = tokio::spawn(async move {
        let send_text = |m: &ServerMessage| {
            Message::Text(serde_json::to_string(m).expect("serializable").into())
        };
        if ws_tx.send(send_text(&hello)).await.is_err() {
            return;
        }
        if ws_tx
            .send(send_text(&ServerMessage::Topics {
                topics: initial_topics,
            }))
            .await
            .is_err()
        {
            return;
        }
        let mut clock = tokio::time::interval(CLOCK_PERIOD);
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut buf = BytesMut::new();
        loop {
            tokio::select! {
                _ = writer_wake.notified() => {
                    // Drain all slots round-robin until nothing is pending.
                    loop {
                        let slots: Vec<_> = writer_subs.lock().unwrap().values().map(|s| s.slot.clone()).collect();
                        let mut sent_any = false;
                        for slot in slots {
                            if let Some(frame) = slot.pop() {
                                buf.reserve(FrameHeader::SIZE + frame.payload.len());
                                let header = FrameHeader { kind: wire::kind::MESSAGE, subscription_id: frame.id, receive_time_ns: frame.receive_time_ns };
                                buf.put_slice(&header.encode());
                                buf.put_slice(&frame.payload);
                                if ws_tx.send(Message::Binary(buf.split().freeze())).await.is_err() {
                                    return;
                                }
                                sent_any = true;
                            }
                        }
                        if !sent_any {
                            break;
                        }
                    }
                }
                Some(msg) = ctl_rx.recv() => {
                    if ws_tx.send(send_text(&msg)).await.is_err() {
                        return;
                    }
                }
                Ok(topics) = topics_rx.recv() => {
                    if ws_tx.send(send_text(&ServerMessage::Topics { topics })).await.is_err() {
                        return;
                    }
                }
                _ = clock.tick() => {
                    let msg = ServerMessage::Clock { ros_time_ns: hub.transport().now(), wall_time_ns: crate::hub::wall_now_ns() };
                    if ws_tx.send(send_text(&msg)).await.is_err() {
                        return;
                    }
                }
            }
        }
    });

    // ---- reader -------------------------------------------------------
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                Ok(m) => handle(m, &state, &subs, &wake, &ctl_tx).await,
                Err(e) => {
                    let _ = ctl_tx
                        .send(ServerMessage::Error {
                            id: None,
                            message: format!("bad control message: {e}"),
                        })
                        .await;
                }
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    writer.abort();
    let n = subs.lock().unwrap().len();
    subs.lock().unwrap().clear(); // drops Subscriptions → detaches from the hub
    tracing::info!(session_id, dropped_subscriptions = n, "websocket closed");
}

async fn handle(
    m: ClientMessage,
    state: &AppState,
    subs: &Arc<Mutex<HashMap<SubscriptionId, Subscription>>>,
    wake: &Arc<Notify>,
    ctl_tx: &mpsc::Sender<ServerMessage>,
) {
    match m {
        ClientMessage::Subscribe {
            id,
            topic,
            type_name,
            qos,
        } => {
            // Replace silently if the client re-sends the same id (reconnect replay).
            subs.lock().unwrap().remove(&id);
            let key = Key {
                topic,
                type_name,
                qos,
            };
            let hub = state.hub.clone();
            let slot_wake = wake.clone();
            // subscribe_raw may block briefly on the ROS node mutex.
            let result = tokio::task::spawn_blocking(move || hub.subscribe(key, id, slot_wake))
                .await
                .expect("subscribe task");
            match result {
                Ok(sub) => {
                    subs.lock().unwrap().insert(id, sub);
                    // A latched message may already be waiting in the slot; its notify
                    // fired before the slot was visible to the writer.
                    wake.notify_one();
                }
                Err(e) => {
                    let _ = ctl_tx
                        .send(ServerMessage::Error {
                            id: Some(id),
                            message: e.to_string(),
                        })
                        .await;
                }
            }
        }
        ClientMessage::Unsubscribe { id } => {
            subs.lock().unwrap().remove(&id);
        }
        ClientMessage::ListTopics => {
            let topics = state.refresh_topics().await;
            let _ = ctl_tx.send(ServerMessage::Topics { topics }).await;
        }
        ClientMessage::Publish {
            topic,
            type_name,
            qos,
            msg,
        } => {
            let t = state.hub.transport().clone();
            let r =
                tokio::task::spawn_blocking(move || t.publish_json(&topic, &type_name, qos, &msg))
                    .await
                    .expect("publish task");
            if let Err(e) = r {
                let _ = ctl_tx
                    .send(ServerMessage::Error {
                        id: None,
                        message: format!("publish failed: {e}"),
                    })
                    .await;
            }
        }
    }
}

/// Polls the topic graph and broadcasts it to every session when it changes.
pub async fn topic_watcher(state: AppState, period: Duration) {
    let mut tick = tokio::time::interval(period);
    loop {
        tick.tick().await;
        state.refresh_topics().await;
    }
}

pub type TopicsTx = broadcast::Sender<Vec<TopicInfo>>;

impl AppState {
    /// Queries the transport; broadcasts and caches the list if it changed.
    pub async fn refresh_topics(&self) -> Vec<TopicInfo> {
        let t = self.hub.transport().clone();
        let topics = match tokio::task::spawn_blocking(move || t.list_topics())
            .await
            .expect("list task")
        {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("list_topics failed: {e}");
                return self.current_topics();
            }
        };
        let changed = {
            let mut cur = self.topics.lock().unwrap();
            if *cur != topics {
                *cur = topics.clone();
                true
            } else {
                false
            }
        };
        if changed {
            let _ = self.topics_tx.send(topics.clone());
        }
        topics
    }

    pub fn current_topics(&self) -> Vec<TopicInfo> {
        self.topics.lock().unwrap().clone()
    }
}
