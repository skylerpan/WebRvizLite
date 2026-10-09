//! Transport abstraction between the server and ROS 2.
//!
//! The server only ever talks to [`Transport`]. Implementations:
//! - `r2r` (feature `r2r`): real ROS 2 node via rcl; needs a sourced ROS 2 at build time.
//! - `mock`: a synthetic navigation scene (`/scan`, `/points`, `/tf`, `/odom`, markers, map,
//!   camera, ... see `mock.rs`) for development without ROS.
//!
//! The trait is deliberately narrow so a pure-Rust DDS backend can replace r2r later.

#![forbid(unsafe_code)]

pub mod mock;
#[cfg(feature = "r2r")]
pub mod r2r_transport;

use std::pin::Pin;

use bytes::Bytes;
use futures_core::Stream;
pub use webrvizlite_core::protocol::{QosProfile, TopicInfo};

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// The message package was not available when the bridge was built
    /// (r2r resolves typesupport at compile time; see `IDL_PACKAGE_FILTER`).
    #[error("unknown message type: {0}")]
    UnknownType(String),
    #[error("invalid topic name: {0}")]
    InvalidTopic(String),
    #[error("{0}")]
    Other(String),
}

/// Raw serialized (CDR) messages for one ROS subscription, newest last.
/// **Dropping the stream unsubscribes.** Implementations must not block the
/// ROS executor when the consumer is slow: they may drop messages instead.
pub type RawMessageStream = Pin<Box<dyn Stream<Item = Bytes> + Send>>;

/// Wall-clock-independent ROS time, in nanoseconds.
pub type RosTimeNs = u64;

pub trait Transport: Send + Sync + 'static {
    /// Human-readable backend name for the `hello` message (`"humble"`, `"mock"`).
    fn ros_distro(&self) -> Option<String>;

    /// Topics currently visible on the graph.
    fn list_topics(&self) -> Result<Vec<TopicInfo>, TransportError>;

    /// Subscribe with raw (serialized) delivery. The server never deserializes.
    fn subscribe_raw(
        &self,
        topic: &str,
        type_name: &str,
        qos: QosProfile,
    ) -> Result<RawMessageStream, TransportError>;

    /// Publish one message given as JSON in ROS 2 field layout. Publishers are
    /// cached per `(topic, type)` inside the implementation.
    fn publish_json(
        &self,
        topic: &str,
        type_name: &str,
        qos: QosProfile,
        msg: &serde_json::Value,
    ) -> Result<(), TransportError>;

    /// Current ROS time. Sim time (from `/clock`) when the node runs with
    /// `use_sim_time`, otherwise system time.
    fn now(&self) -> RosTimeNs;

    /// Whether [`Transport::now`] is sim time.
    fn use_sim_time(&self) -> bool;
}
