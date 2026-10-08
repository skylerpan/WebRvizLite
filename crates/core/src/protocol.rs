//! Control-plane messages exchanged as WebSocket **text** frames (JSON).
//! Data-plane messages are **binary** frames described in [`crate::wire`].
//!
//! Shared by the server (native) and the worker (WASM). JSON shape: every
//! message is an object with an `"op"` discriminator in `snake_case`, e.g.
//!
//! ```json
//! {"op":"subscribe","id":7,"topic":"/scan","type":"sensor_msgs/msg/LaserScan",
//!  "qos":{"depth":5,"history":"keep_last","reliability":"best_effort","durability":"volatile"}}
//! ```

use serde::{Deserialize, Serialize};

#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

/// Client-chosen identifier for one subscription. Also carried in every binary
/// frame header so the worker can route payloads without parsing them.
pub type SubscriptionId = u32;

// ---------------------------------------------------------------------------
// QoS
// ---------------------------------------------------------------------------

/// The four QoS fields RViz exposes per topic (spec §7.5). Anything else
/// (deadline, lifespan, liveliness) stays at the RMW default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct QosProfile {
    pub depth: u32,
    pub history: HistoryPolicy,
    pub reliability: ReliabilityPolicy,
    pub durability: DurabilityPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryPolicy {
    SystemDefault,
    KeepLast,
    KeepAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReliabilityPolicy {
    SystemDefault,
    Reliable,
    BestEffort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurabilityPolicy {
    SystemDefault,
    TransientLocal,
    Volatile,
}

impl QosProfile {
    /// rclcpp `QoS(depth)`: keep last `depth`, reliable, volatile. RViz uses depth 5
    /// for tools and most displays.
    pub const fn keep_last(depth: u32) -> Self {
        Self {
            depth,
            history: HistoryPolicy::KeepLast,
            reliability: ReliabilityPolicy::Reliable,
            durability: DurabilityPolicy::Volatile,
        }
    }

    /// `/tf_static`: transient local so late joiners receive the static transforms.
    pub const fn transient_local(depth: u32) -> Self {
        Self {
            durability: DurabilityPolicy::TransientLocal,
            ..Self::keep_last(depth)
        }
    }

    pub const fn best_effort(self) -> Self {
        Self {
            reliability: ReliabilityPolicy::BestEffort,
            ..self
        }
    }

    /// Backpressure class (spec §4.3): best effort keeps only the newest pending
    /// frame; everything else is queued up to `depth`.
    pub fn is_best_effort(&self) -> bool {
        self.reliability == ReliabilityPolicy::BestEffort
    }
}

impl Default for QosProfile {
    fn default() -> Self {
        Self::keep_last(5)
    }
}

// ---------------------------------------------------------------------------
// Topic graph
// ---------------------------------------------------------------------------

/// One topic on the graph. A topic can be advertised with more than one type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicInfo {
    pub name: String,
    /// Fully qualified ROS 2 type names, e.g. `sensor_msgs/msg/LaserScan`.
    pub types: Vec<String>,
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

/// Sent by the worker. Every variant is idempotent per `id` so the worker can
/// blindly replay its subscription table after a reconnect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Start delivering raw CDR frames for `topic`. The server creates at most
    /// one ROS subscription per distinct `(topic, type, qos)`, shared across ids
    /// and connections.
    Subscribe {
        id: SubscriptionId,
        topic: String,
        #[serde(rename = "type")]
        type_name: String,
        #[serde(default)]
        qos: QosProfile,
    },
    /// Stop delivering frames for `id`. Unknown ids are ignored.
    Unsubscribe { id: SubscriptionId },
    /// Request the current topic graph; answered with [`ServerMessage::Topics`].
    ListTopics,
    /// Publish one message given as JSON in the ROS 2 field layout
    /// (what `ros2 topic pub` accepts). Used by the SetInitialPose / SetGoal /
    /// PublishPoint tools and InteractiveMarker feedback.
    Publish {
        topic: String,
        #[serde(rename = "type")]
        type_name: String,
        #[serde(default)]
        qos: QosProfile,
        #[cfg(feature = "std")]
        msg: serde_json::Value,
        #[cfg(not(feature = "std"))]
        msg: String,
    },
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

/// Sent by the server as text frames. Binary frames ([`crate::wire`]) are the
/// only other thing the server sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ServerMessage {
    /// First message after the WebSocket opens.
    Hello {
        /// Server crate version.
        version: String,
        /// `ROS_DISTRO` the bridge was built against; `None` for the mock transport.
        ros_distro: Option<String>,
        /// True when the server was started with `--mock` (synthetic topics, no ROS).
        mock: bool,
        /// True when ROS time comes from `/clock` (`use_sim_time`).
        use_sim_time: bool,
        /// Config file passed with `-d`, if any (the client fetches it over HTTP).
        display_config: Option<String>,
        /// Fixed Frame override from `-f`, if any.
        fixed_frame: Option<String>,
    },
    /// Reply to [`ClientMessage::ListTopics`]. May also be pushed unsolicited
    /// when the graph changes.
    Topics { topics: Vec<TopicInfo> },
    /// ROS time, pushed at ~10 Hz (or on every `/clock` message, throttled, when
    /// `use_sim_time`). Lets the Time panel show ROS Time / Elapsed without
    /// trusting the browser's clock.
    Clock {
        /// ROS time in nanoseconds (sim time when `use_sim_time`, else wall).
        ros_time_ns: u64,
        /// Server wall clock at the moment this message was built.
        wall_time_ns: u64,
    },
    /// Something failed. `id` is set when it concerns one subscription, e.g. an
    /// unknown message type; the subscription is then dead and the client should
    /// surface it as a Topic status error on the display.
    Error {
        id: Option<SubscriptionId>,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribe_json_shape() {
        let m = ClientMessage::Subscribe {
            id: 7,
            topic: "/scan".into(),
            type_name: "sensor_msgs/msg/LaserScan".into(),
            qos: QosProfile::keep_last(5).best_effort(),
        };
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(
            json,
            r#"{"op":"subscribe","id":7,"topic":"/scan","type":"sensor_msgs/msg/LaserScan","qos":{"depth":5,"history":"keep_last","reliability":"best_effort","durability":"volatile"}}"#
        );
        assert_eq!(serde_json::from_str::<ClientMessage>(&json).unwrap(), m);
    }

    #[test]
    fn qos_defaults_when_omitted() {
        let m: ClientMessage = serde_json::from_str(
            r#"{"op":"subscribe","id":1,"topic":"/tf","type":"tf2_msgs/msg/TFMessage"}"#,
        )
        .unwrap();
        match m {
            ClientMessage::Subscribe { qos, .. } => assert_eq!(qos, QosProfile::keep_last(5)),
            _ => panic!(),
        }
    }

    #[test]
    fn server_messages_round_trip() {
        let msgs = [
            ServerMessage::Hello {
                version: "0.1.0".into(),
                ros_distro: Some("humble".into()),
                mock: false,
                use_sim_time: false,
                display_config: None,
                fixed_frame: None,
            },
            ServerMessage::Topics {
                topics: vec![TopicInfo {
                    name: "/scan".into(),
                    types: vec!["sensor_msgs/msg/LaserScan".into()],
                }],
            },
            ServerMessage::Clock {
                ros_time_ns: 1,
                wall_time_ns: 2,
            },
            ServerMessage::Error {
                id: Some(3),
                message: "unknown type".into(),
            },
        ];
        for m in msgs {
            let json = serde_json::to_string(&m).unwrap();
            assert!(json.starts_with(r#"{"op":""#), "{json}");
            assert_eq!(serde_json::from_str::<ServerMessage>(&json).unwrap(), m);
        }
    }

    #[test]
    fn list_topics_is_just_op() {
        assert_eq!(
            serde_json::to_string(&ClientMessage::ListTopics).unwrap(),
            r#"{"op":"list_topics"}"#
        );
    }
}
