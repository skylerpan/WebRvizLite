//! Real ROS 2 transport on top of r2r.
//!
//! r2r's `Node` is `!Sync` and every call needs `&mut`, so the node is owned by
//! a dedicated OS thread that alternates between `spin_once` and running jobs
//! sent over a channel (a mutex around the node starves callers: the spin loop
//! re-locks it faster than a waiter can wake up). Subscriptions are torn down
//! by r2r on the next spin after their stream is dropped; on a quiet topic that
//! happens only when its next message arrives.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use tokio_stream::StreamExt;

use crate::{QosProfile, RawMessageStream, RosTimeNs, TopicInfo, Transport, TransportError};
use webrvizlite_core::protocol::{DurabilityPolicy, HistoryPolicy, ReliabilityPolicy};

type Job = Box<dyn FnOnce(&mut r2r::Node) + Send>;

const SPIN_TIMEOUT: Duration = Duration::from_millis(10);

pub struct R2rTransport {
    jobs: mpsc::Sender<Job>,
    clock: Arc<Mutex<r2r::Clock>>,
    use_sim_time: bool,
    publishers: Mutex<HashMap<(String, String), r2r::PublisherUntyped>>,
}

impl R2rTransport {
    /// Creates the node `webrvizlite` and starts the spin thread. ROS CLI args
    /// (`--ros-args ...`) are read from the process arguments by rcl itself.
    pub fn new() -> Result<Arc<Self>, TransportError> {
        let ctx = r2r::Context::create().map_err(other)?;
        let mut node = r2r::Node::create(ctx, "webrvizlite", "").map_err(other)?;
        let use_sim_time = node.get_parameter::<bool>("use_sim_time").unwrap_or(false);
        let clock = Arc::new(Mutex::new(
            r2r::Clock::create(r2r::ClockType::RosTime).map_err(other)?,
        ));
        if use_sim_time {
            node.get_time_source()
                .attach_ros_clock(Arc::downgrade(&clock))
                .map_err(other)?;
        }
        let (jobs, jobs_rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("r2r-spin".into())
            .spawn(move || {
                loop {
                    node.spin_once(SPIN_TIMEOUT);
                    while let Ok(job) = jobs_rx.try_recv() {
                        job(&mut node);
                    }
                }
            })
            .map_err(|e| TransportError::Other(e.to_string()))?;
        Ok(Arc::new(Self {
            jobs,
            clock,
            use_sim_time,
            publishers: Mutex::new(HashMap::new()),
        }))
    }

    /// Runs `f` on the spin thread with exclusive access to the node and waits
    /// for its result (at most one spin timeout of latency).
    fn with_node<R, F>(&self, f: F) -> R
    where
        R: Send + 'static,
        F: FnOnce(&mut r2r::Node) -> R + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        self.jobs
            .send(Box::new(move |node| {
                let _ = tx.send(f(node));
            }))
            .expect("r2r spin thread is alive");
        rx.recv().expect("r2r job completed")
    }
}

fn other(e: r2r::Error) -> TransportError {
    match e {
        r2r::Error::InvalidMessageType { msgtype } => TransportError::UnknownType(msgtype),
        e => TransportError::Other(e.to_string()),
    }
}

fn qos(q: QosProfile) -> r2r::QosProfile {
    let mut p = r2r::QosProfile::default();
    p.depth = q.depth as usize;
    p.history = match q.history {
        HistoryPolicy::SystemDefault => r2r::qos::HistoryPolicy::SystemDefault,
        HistoryPolicy::KeepLast => r2r::qos::HistoryPolicy::KeepLast,
        HistoryPolicy::KeepAll => r2r::qos::HistoryPolicy::KeepAll,
    };
    p.reliability = match q.reliability {
        ReliabilityPolicy::SystemDefault => r2r::qos::ReliabilityPolicy::SystemDefault,
        ReliabilityPolicy::Reliable => r2r::qos::ReliabilityPolicy::Reliable,
        ReliabilityPolicy::BestEffort => r2r::qos::ReliabilityPolicy::BestEffort,
    };
    p.durability = match q.durability {
        DurabilityPolicy::SystemDefault => r2r::qos::DurabilityPolicy::SystemDefault,
        DurabilityPolicy::TransientLocal => r2r::qos::DurabilityPolicy::TransientLocal,
        DurabilityPolicy::Volatile => r2r::qos::DurabilityPolicy::Volatile,
    };
    p
}

impl Transport for R2rTransport {
    fn ros_distro(&self) -> Option<String> {
        std::env::var("ROS_DISTRO")
            .ok()
            .or_else(|| Some(option_env!("ROS_DISTRO").unwrap_or("unknown").into()))
    }

    fn list_topics(&self) -> Result<Vec<TopicInfo>, TransportError> {
        let map = self
            .with_node(|n| n.get_topic_names_and_types())
            .map_err(other)?;
        let mut topics: Vec<TopicInfo> = map
            .into_iter()
            .map(|(name, types)| TopicInfo { name, types })
            .collect();
        topics.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(topics)
    }

    fn subscribe_raw(
        &self,
        topic: &str,
        type_name: &str,
        q: QosProfile,
    ) -> Result<RawMessageStream, TransportError> {
        let (topic, type_name) = (topic.to_string(), type_name.to_string());
        let stream = self
            .with_node(move |n| n.subscribe_raw(&topic, &type_name, qos(q)))
            .map_err(other)?;
        Ok(Box::pin(stream.map(Bytes::from)))
    }

    fn publish_json(
        &self,
        topic: &str,
        type_name: &str,
        q: QosProfile,
        msg: &serde_json::Value,
    ) -> Result<(), TransportError> {
        let key = (topic.to_string(), type_name.to_string());
        let mut pubs = self.publishers.lock().unwrap();
        if !pubs.contains_key(&key) {
            let (t, ty) = key.clone();
            let p = self
                .with_node(move |n| n.create_publisher_untyped(&t, &ty, qos(q)))
                .map_err(other)?;
            pubs.insert(key.clone(), p);
        }
        pubs[&key].publish(msg.clone()).map_err(other)
    }

    fn now(&self) -> RosTimeNs {
        self.clock
            .lock()
            .unwrap()
            .get_now()
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    }

    fn use_sim_time(&self) -> bool {
        self.use_sim_time
    }
}
