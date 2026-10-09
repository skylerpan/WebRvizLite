//! One WebSocket connection: a reader task (control messages) and a writer
//! task (hello, topics, clock, errors, data frames).

use std::collections::HashMap;
#[cfg(feature = "webtransport")]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
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

    // WebTransport: the browser connects to /wt?token=… after reading hello;
    // the accept loop hands the Connection over `wt_rx`, and the browser says
    // when the session is readable (`transport {wt:true}`) via `wt_active`.
    let wt_active = Arc::new(AtomicBool::new(false));
    #[cfg(feature = "webtransport")]
    let (token, wt_rx) = {
        let token = crate::wt::new_token();
        let (tx, rx) = tokio::sync::oneshot::channel();
        if state.wt.is_some() {
            state.wt_pending.lock().unwrap().insert(token.clone(), tx);
        }
        (token, rx)
    };
    #[cfg(not(feature = "webtransport"))]
    let token = String::new();

    // ---- writer -------------------------------------------------------
    let hub = state.hub.clone();
    let writer_subs = subs.clone();
    let writer_wake = wake.clone();
    let writer_wt_active = wt_active.clone();
    let hello = state.hello(&token);
    let initial_topics = state.current_topics();
    #[cfg(feature = "webtransport")]
    let mut wt = WtWriter::new(wt_rx, writer_wt_active);
    #[cfg(not(feature = "webtransport"))]
    let mut wt = WtWriter::new(writer_wt_active);
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
                                let bytes = buf.split().freeze();
                                sent_any = true;
                                // Best-effort topics go over WebTransport while the browser's session is up.
                                if slot.latest_only && wt.send(bytes.clone()) {
                                    continue;
                                }
                                if ws_tx.send(Message::Binary(bytes)).await.is_err() {
                                    return;
                                }
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
                conn = wt.wait_connection() => {
                    wt.attach(conn);
                }
            }
        }
    });

    // ---- reader -------------------------------------------------------
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                Ok(m) => handle(m, &state, &subs, &wake, &ctl_tx, &wt_active).await,
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
    #[cfg(feature = "webtransport")]
    state.wt_pending.lock().unwrap().remove(&token);
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
    wt_active: &Arc<AtomicBool>,
) {
    match m {
        ClientMessage::Transport { wt } => {
            tracing::info!(wt, "client transport changed");
            wt_active.store(wt, Ordering::Relaxed);
        }
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
            let (topic, type_name) = (key.topic.clone(), key.type_name.clone());
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
                    // The client only shows this in its display status; log it here
                    // too so an unsupported type (package missing at build time) is
                    // visible on the server side.
                    tracing::warn!(id, %topic, %type_name, error = %e, "subscribe failed");
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

// ---------------------------------------------------------------------------
// WebTransport writer: datagrams for small frames, one unidirectional stream
// per larger message (point clouds are megabytes; datagrams are ~1.2 KB).
// Any failure flips the session back to the WebSocket for good.
// ---------------------------------------------------------------------------

#[cfg(feature = "webtransport")]
struct WtWriter {
    rx: Option<tokio::sync::oneshot::Receiver<wtransport::Connection>>,
    conn: Option<wtransport::Connection>,
    /// The browser reported its session usable (`transport {wt:true}`).
    active: Arc<AtomicBool>,
    /// A send failed or the connection closed: stay on the WebSocket.
    broken: Arc<AtomicBool>,
    /// Streams still being written; beyond a couple we drop the frame instead of queueing latency.
    in_flight: Arc<AtomicUsize>,
}

#[cfg(feature = "webtransport")]
impl WtWriter {
    const MAX_IN_FLIGHT: usize = 2;

    fn new(
        rx: tokio::sync::oneshot::Receiver<wtransport::Connection>,
        active: Arc<AtomicBool>,
    ) -> Self {
        Self {
            rx: Some(rx),
            conn: None,
            active,
            broken: Arc::new(AtomicBool::new(false)),
            in_flight: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Resolves once the accept loop hands over the session's connection (at most once).
    async fn wait_connection(&mut self) -> Option<wtransport::Connection> {
        match self.rx.as_mut() {
            Some(rx) => {
                let r = rx.await.ok();
                self.rx = None;
                r
            }
            None => std::future::pending().await,
        }
    }

    fn attach(&mut self, conn: Option<wtransport::Connection>) {
        if let Some(conn) = conn {
            let broken = self.broken.clone();
            let c = conn.clone();
            tokio::spawn(async move {
                let e = c.closed().await;
                tracing::info!("webtransport session closed: {e}");
                broken.store(true, Ordering::Relaxed);
            });
            self.conn = Some(conn);
        }
    }

    fn usable(&self) -> bool {
        self.conn.is_some()
            && self.active.load(Ordering::Relaxed)
            && !self.broken.load(Ordering::Relaxed)
    }

    /// Sends a framed message; false when it must go over the WebSocket instead.
    fn send(&self, bytes: bytes::Bytes) -> bool {
        if !self.usable() {
            return false;
        }
        let conn = self.conn.as_ref().expect("usable implies connection");
        if bytes.len() <= conn.max_datagram_size().unwrap_or(0) {
            if let Err(e) = conn.send_datagram(bytes) {
                tracing::warn!("webtransport datagram failed, falling back to websocket: {e}");
                self.broken.store(true, Ordering::Relaxed);
                return false;
            }
            return true;
        }
        if self.in_flight.load(Ordering::Relaxed) >= Self::MAX_IN_FLIGHT {
            // The client is not keeping up; this is a best-effort topic, drop the frame.
            return true;
        }
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        let conn = conn.clone();
        let broken = self.broken.clone();
        let in_flight = self.in_flight.clone();
        tokio::spawn(async move {
            let result: Result<(), String> = async {
                let mut stream = conn
                    .open_uni()
                    .await
                    .map_err(|e| e.to_string())?
                    .await
                    .map_err(|e| e.to_string())?;
                stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
                stream.finish().await.map_err(|e| e.to_string())
            }
            .await;
            if let Err(e) = result {
                tracing::warn!("webtransport stream failed, falling back to websocket: {e}");
                broken.store(true, Ordering::Relaxed);
            }
            in_flight.fetch_sub(1, Ordering::Relaxed);
        });
        true
    }
}

#[cfg(not(feature = "webtransport"))]
struct WtWriter;

#[cfg(not(feature = "webtransport"))]
impl WtWriter {
    fn new(_active: Arc<AtomicBool>) -> Self {
        Self
    }
    async fn wait_connection(&mut self) -> Option<()> {
        std::future::pending().await
    }
    fn attach(&mut self, _conn: Option<()>) {}
    fn send(&self, _bytes: bytes::Bytes) -> bool {
        false
    }
}
