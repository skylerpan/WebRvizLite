//! Subscription hub: one ROS subscription per distinct `(topic, type, qos)`,
//! fanned out to per-session slots with QoS-dependent backpressure
//! (spec §4.3): best effort keeps only the newest frame, reliable keeps a
//! bounded queue of `depth` frames and drops the oldest.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use tokio::sync::Notify;
use tokio::task::AbortHandle;
use tokio_stream::StreamExt;
use webrvizlite_bridge::{QosProfile, Transport, TransportError};
use webrvizlite_core::protocol::{DurabilityPolicy, SubscriptionId};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    pub topic: String,
    pub type_name: String,
    pub qos: QosProfile,
}

/// One received message, ready to be framed for a specific client subscription.
pub struct Frame {
    pub id: SubscriptionId,
    pub receive_time_ns: u64,
    pub payload: Bytes,
}

/// Pending-frame slot for one client subscription.
pub struct Slot {
    pub id: SubscriptionId,
    latest_only: bool,
    capacity: usize,
    queue: Mutex<VecDeque<Frame>>,
    wake: Arc<Notify>,
    /// Frames discarded because the client was not keeping up.
    pub dropped: AtomicU64,
}

impl Slot {
    fn push(&self, payload: Bytes, receive_time_ns: u64) {
        let mut q = self.queue.lock().unwrap();
        if self.latest_only {
            if q.pop_front().is_some() {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        } else if q.len() >= self.capacity {
            q.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        q.push_back(Frame {
            id: self.id,
            receive_time_ns,
            payload,
        });
        drop(q);
        self.wake.notify_one();
    }

    pub fn pop(&self) -> Option<Frame> {
        self.queue.lock().unwrap().pop_front()
    }
}

type SlotList = Arc<Mutex<Vec<Arc<Slot>>>>;
/// `(payload, receive_time_ns)` of the newest message on a transient-local key.
type Latched = Arc<Mutex<Option<(Bytes, u64)>>>;

struct Shared {
    slots: SlotList,
    task: AbortHandle,
    /// Last payload for transient-local keys, replayed to slots that attach
    /// after the ROS subscription already consumed the publisher's history.
    latched: Option<Latched>,
}

pub struct Hub {
    transport: Arc<dyn Transport>,
    inner: Mutex<HashMap<Key, Shared>>,
}

/// Keeps a client subscription alive; dropping it detaches the slot and, when
/// it was the last one, drops the ROS subscription.
pub struct Subscription {
    hub: Arc<Hub>,
    key: Key,
    pub slot: Arc<Slot>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.detach(&self.key, &self.slot);
    }
}

pub fn wall_now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

impl Hub {
    pub fn new(transport: Arc<dyn Transport>) -> Arc<Self> {
        Arc::new(Self {
            transport,
            inner: Mutex::new(HashMap::new()),
        })
    }

    pub fn transport(&self) -> &Arc<dyn Transport> {
        &self.transport
    }

    /// Number of live ROS subscriptions (for logging / debug).
    pub fn ros_subscription_count(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    /// Attaches a slot for client subscription `id` to the shared ROS
    /// subscription for `key`, creating it on first use.
    pub fn subscribe(
        self: &Arc<Self>,
        key: Key,
        id: SubscriptionId,
        wake: Arc<Notify>,
    ) -> Result<Subscription, TransportError> {
        let slot = Arc::new(Slot {
            id,
            latest_only: key.qos.is_best_effort(),
            capacity: key.qos.depth.max(1) as usize,
            queue: Mutex::new(VecDeque::new()),
            wake,
            dropped: AtomicU64::new(0),
        });

        let mut inner = self.inner.lock().unwrap();
        if !inner.contains_key(&key) {
            let mut stream = self
                .transport
                .subscribe_raw(&key.topic, &key.type_name, key.qos)?;
            // Register the slot before the fan-out task can run, or a latched
            // (transient local) first message would be delivered to nobody.
            let slots: SlotList = Arc::new(Mutex::new(vec![slot.clone()]));
            let fanout = slots.clone();
            let topic = key.topic.clone();
            let latched = (key.qos.durability == DurabilityPolicy::TransientLocal)
                .then(|| Arc::new(Mutex::new(None)));
            let latch = latched.clone();
            let task = tokio::spawn(async move {
                while let Some(payload) = stream.next().await {
                    let t = wall_now_ns();
                    tracing::trace!(%topic, len = payload.len(), "raw message");
                    if let Some(l) = &latch {
                        *l.lock().unwrap() = Some((payload.clone(), t));
                    }
                    for s in fanout.lock().unwrap().iter() {
                        s.push(payload.clone(), t);
                    }
                }
                tracing::debug!(%topic, "raw stream ended");
            })
            .abort_handle();
            tracing::info!(topic = %key.topic, type_name = %key.type_name, ?key.qos, "ros subscribe");
            inner.insert(
                key.clone(),
                Shared {
                    slots,
                    task,
                    latched,
                },
            );
        } else {
            let shared = &inner[&key];
            if let Some((payload, t)) = shared
                .latched
                .as_ref()
                .and_then(|l| l.lock().unwrap().clone())
            {
                slot.push(payload, t);
            }
            shared.slots.lock().unwrap().push(slot.clone());
        }
        Ok(Subscription {
            hub: self.clone(),
            key,
            slot,
        })
    }

    fn detach(&self, key: &Key, slot: &Arc<Slot>) {
        let mut inner = self.inner.lock().unwrap();
        let Some(shared) = inner.get(key) else { return };
        let remaining = {
            let mut slots = shared.slots.lock().unwrap();
            slots.retain(|s| !Arc::ptr_eq(s, slot));
            slots.len()
        };
        if remaining == 0 {
            shared.task.abort();
            inner.remove(key);
            tracing::info!(topic = %key.topic, "ros unsubscribe (last client detached)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(latest_only: bool, capacity: usize) -> Slot {
        Slot {
            id: 1,
            latest_only,
            capacity,
            queue: Mutex::new(VecDeque::new()),
            wake: Arc::new(Notify::new()),
            dropped: AtomicU64::new(0),
        }
    }

    #[test]
    fn best_effort_keeps_only_newest() {
        let s = slot(true, 5);
        for i in 0..4u8 {
            s.push(Bytes::from(vec![i]), i as u64);
        }
        let f = s.pop().unwrap();
        assert_eq!(&f.payload[..], &[3]);
        assert_eq!(f.receive_time_ns, 3);
        assert!(s.pop().is_none());
        assert_eq!(s.dropped.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn reliable_queues_up_to_depth_and_drops_oldest() {
        let s = slot(false, 3);
        for i in 0..5u8 {
            s.push(Bytes::from(vec![i]), 0);
        }
        let got: Vec<u8> = std::iter::from_fn(|| s.pop())
            .map(|f| f.payload[0])
            .collect();
        assert_eq!(got, vec![2, 3, 4]);
        assert_eq!(s.dropped.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn push_wakes_the_writer() {
        let s = slot(false, 1);
        s.push(Bytes::new(), 0);
        // notify_one stores a permit when nobody is waiting, so this returns immediately.
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(std::time::Duration::from_millis(100), s.wake.notified())
                    .await
                    .unwrap()
            });
    }
}
