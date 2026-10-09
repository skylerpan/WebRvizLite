//! ROS-free transport that synthesizes a small navigation scene so the whole
//! pipeline can be exercised on a machine without ROS 2:
//!
//! | topic | type | rate |
//! |---|---|---|
//! | `/scan` | sensor_msgs/msg/LaserScan | 10 Hz |
//! | `/livox/lidar` | livox_ros_driver2/msg/CustomMsg | 10 Hz (while subscribed) |
//! | `/points` | sensor_msgs/msg/PointCloud2 (300k points) | 10 Hz |
//! | `/tf` | tf2_msgs/msg/TFMessage | 30 Hz |
//! | `/tf_static` | tf2_msgs/msg/TFMessage | latched (transient local) |
//! | `/clock` | rosgraph_msgs/msg/Clock | 50 Hz |
//! | `/map` | nav_msgs/msg/OccupancyGrid | latched |
//! | `/robot_description` | std_msgs/msg/String (URDF) | latched |
//! | `/plan`, `/goal_pose`, `/particlecloud` | nav_msgs/msg/Path, geometry_msgs/msg/PoseStamped, PoseArray | 2 Hz |
//! | `/markers`, `/marker` | visualization_msgs/msg/MarkerArray, Marker | 1 Hz |
//! | `/odom` | nav_msgs/msg/Odometry | 20 Hz |
//! | `/amcl_pose` | geometry_msgs/msg/PoseWithCovarianceStamped | 1 Hz |
//! | `/grid_cells` | nav_msgs/msg/GridCells | 1 Hz |
//! | `/clicked_point_echo` | geometry_msgs/msg/PointStamped | 2 Hz |
//! | `/footprint` | geometry_msgs/msg/PolygonStamped | 5 Hz |
//! | `/range` | sensor_msgs/msg/Range | 10 Hz |
//! | `/camera/image_raw`, `/camera/depth/image_raw` | sensor_msgs/msg/Image (rgb8 / 16UC1, 160×120) | 5 Hz (while subscribed) |
//! | `/camera/camera_info` | sensor_msgs/msg/CameraInfo | 5 Hz |
//!
//! The robot drives a circle of radius 2 m inside an 8 m × 6 m room; the scan is
//! a ray cast against the walls. `tools/mock_scene.py` publishes the same scene
//! with rclpy for testing the real r2r path inside the ROS container.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use tokio::sync::broadcast;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use webrvizlite_core::cdr::Writer;

use crate::{QosProfile, RawMessageStream, RosTimeNs, TopicInfo, Transport, TransportError};

pub const SCAN_TOPIC: &str = "/scan";
pub const SCAN_TYPE: &str = "sensor_msgs/msg/LaserScan";
pub const TF_TOPIC: &str = "/tf";
pub const TF_STATIC_TOPIC: &str = "/tf_static";
pub const TF_TYPE: &str = "tf2_msgs/msg/TFMessage";
pub const CLOCK_TOPIC: &str = "/clock";
pub const CLOCK_TYPE: &str = "rosgraph_msgs/msg/Clock";
pub const MAP_TOPIC: &str = "/map";
pub const MAP_TYPE: &str = "nav_msgs/msg/OccupancyGrid";
pub const PATH_TOPIC: &str = "/plan";
pub const PATH_TYPE: &str = "nav_msgs/msg/Path";
pub const GOAL_TOPIC: &str = "/goal_pose";
pub const POSE_TYPE: &str = "geometry_msgs/msg/PoseStamped";
pub const POINTS_TOPIC: &str = "/points";
pub const POINTS_TYPE: &str = "sensor_msgs/msg/PointCloud2";
/// Spec §1 performance target: one PointCloud2 of 300k points at 10 Hz.
pub const POINTS_COUNT: usize = 300_000;
pub const MARKERS_TOPIC: &str = "/markers";
pub const MARKER_ARRAY_TYPE: &str = "visualization_msgs/msg/MarkerArray";
pub const MARKER_TOPIC: &str = "/marker";
pub const MARKER_TYPE: &str = "visualization_msgs/msg/Marker";
/// Spec §8.1 M6: 5,000 CUBE markers must stay at 60 FPS.
pub const CUBE_MARKERS: usize = 5_000;
pub const PARTICLE_TOPIC: &str = "/particlecloud";
pub const LIVOX_TOPIC: &str = "/livox/lidar";
pub const LIVOX_TYPE: &str = "livox_ros_driver2/msg/CustomMsg";
// Tier 1 topics
pub const ODOM_TOPIC: &str = "/odom";
pub const ODOM_TYPE: &str = "nav_msgs/msg/Odometry";
pub const AMCL_POSE_TOPIC: &str = "/amcl_pose";
pub const POSE_COV_TYPE: &str = "geometry_msgs/msg/PoseWithCovarianceStamped";
pub const POINT_TOPIC: &str = "/clicked_point_echo";
pub const POINT_TYPE: &str = "geometry_msgs/msg/PointStamped";
pub const FOOTPRINT_TOPIC: &str = "/footprint";
pub const POLYGON_TYPE: &str = "geometry_msgs/msg/PolygonStamped";
pub const GRID_CELLS_TOPIC: &str = "/grid_cells";
pub const GRID_CELLS_TYPE: &str = "nav_msgs/msg/GridCells";
pub const RANGE_TOPIC: &str = "/range";
pub const RANGE_TYPE: &str = "sensor_msgs/msg/Range";
pub const IMAGE_TOPIC: &str = "/camera/image_raw";
pub const DEPTH_TOPIC: &str = "/camera/depth/image_raw";
pub const IMAGE_TYPE: &str = "sensor_msgs/msg/Image";
pub const CAMERA_INFO_TOPIC: &str = "/camera/camera_info";
pub const CAMERA_INFO_TYPE: &str = "sensor_msgs/msg/CameraInfo";
/// Synthetic camera: 160 × 120, fx = fy = 120, principal point at the centre.
pub const CAM_W: usize = 160;
pub const CAM_H: usize = 120;
pub const CAM_F: f64 = 120.0;
pub const ROBOT_DESCRIPTION_TOPIC: &str = "/robot_description";
pub const STRING_TYPE: &str = "std_msgs/msg/String";
/// URDF published on /robot_description (meshes resolve through `package://webrvizlite_fixtures/`).
pub const ROBOT_URDF: &str = include_str!("../../../fixtures/robot_description/tier1_robot.urdf");
/// Points per Livox frame (a Mid-360 publishes ~20k points per 100 ms).
pub const LIVOX_POINTS: usize = 24_000;
/// `livox_frame` sits this high above `base_link`.
const LIVOX_HEIGHT: f64 = 0.5;
const ROOM_CEILING: f64 = 2.5;
pub const POSE_ARRAY_TYPE: &str = "geometry_msgs/msg/PoseArray";
const MAP_RESOLUTION: f64 = 0.05;

const ROOM_HALF_X: f64 = 4.0;
const ROOM_HALF_Y: f64 = 3.0;
const CIRCLE_RADIUS: f64 = 2.0;
const CIRCLE_PERIOD_S: f64 = 20.0;
const BEAMS: usize = 360;

struct Channel {
    type_name: &'static str,
    tx: broadcast::Sender<Bytes>,
    /// Last message, replayed to new subscribers (models transient-local latching).
    latched: Mutex<Option<Bytes>>,
}

pub struct MockTransport {
    channels: HashMap<&'static str, Arc<Channel>>,
    /// Topics advertised through `publish_json`, so they show up in `list_topics`.
    published: Mutex<HashMap<String, String>>,
    start: SystemTime,
}

impl MockTransport {
    /// Spawns the generator tasks on the current tokio runtime.
    pub fn new() -> Arc<Self> {
        let mk = |type_name, cap| {
            Arc::new(Channel {
                type_name,
                tx: broadcast::channel(cap).0,
                latched: Mutex::new(None),
            })
        };
        let mut channels = HashMap::new();
        channels.insert(SCAN_TOPIC, mk(SCAN_TYPE, 4));
        channels.insert(LIVOX_TOPIC, mk(LIVOX_TYPE, 2));
        channels.insert(TF_TOPIC, mk(TF_TYPE, 8));
        channels.insert(TF_STATIC_TOPIC, mk(TF_TYPE, 1));
        channels.insert(CLOCK_TOPIC, mk(CLOCK_TYPE, 8));
        channels.insert(MAP_TOPIC, mk(MAP_TYPE, 1));
        channels.insert(PATH_TOPIC, mk(PATH_TYPE, 2));
        channels.insert(GOAL_TOPIC, mk(POSE_TYPE, 2));
        channels.insert(PARTICLE_TOPIC, mk(POSE_ARRAY_TYPE, 2));
        channels.insert(POINTS_TOPIC, mk(POINTS_TYPE, 2));
        channels.insert(MARKERS_TOPIC, mk(MARKER_ARRAY_TYPE, 2));
        channels.insert(MARKER_TOPIC, mk(MARKER_TYPE, 2));
        channels.insert(ODOM_TOPIC, mk(ODOM_TYPE, 4));
        channels.insert(AMCL_POSE_TOPIC, mk(POSE_COV_TYPE, 2));
        channels.insert(POINT_TOPIC, mk(POINT_TYPE, 2));
        channels.insert(FOOTPRINT_TOPIC, mk(POLYGON_TYPE, 2));
        channels.insert(GRID_CELLS_TOPIC, mk(GRID_CELLS_TYPE, 2));
        channels.insert(RANGE_TOPIC, mk(RANGE_TYPE, 4));
        channels.insert(ROBOT_DESCRIPTION_TOPIC, mk(STRING_TYPE, 1));
        channels.insert(IMAGE_TOPIC, mk(IMAGE_TYPE, 2));
        channels.insert(DEPTH_TOPIC, mk(IMAGE_TYPE, 2));
        channels.insert(CAMERA_INFO_TOPIC, mk(CAMERA_INFO_TYPE, 2));
        let this = Arc::new(Self {
            channels,
            published: Mutex::new(HashMap::new()),
            start: SystemTime::now(),
        });

        // tf_static and the map are published once and latched.
        this.channel(TF_STATIC_TOPIC)
            .send(encode_tf_static(now_stamp()));
        this.channel(MAP_TOPIC).send(encode_map(now_stamp()));
        this.channel(ROBOT_DESCRIPTION_TOPIC)
            .send(encode_string(ROBOT_URDF));
        let t = this.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            let mut phase = 0u32;
            loop {
                tick.tick().await;
                phase = phase.wrapping_add(1);
                let (stamp, _) = t.pose_now();
                // Encoding 300k points is CPU work; keep it off the runtime threads.
                let bytes = tokio::task::spawn_blocking(move || encode_points(stamp, phase))
                    .await
                    .unwrap_or_default();
                if t.channel(POINTS_TOPIC).tx.receiver_count() > 0 {
                    t.channel(POINTS_TOPIC).send(bytes);
                }
            }
        });
        let t = this.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(1000));
            let mut phase = 0u32;
            loop {
                tick.tick().await;
                phase = phase.wrapping_add(1);
                let (stamp, pose) = t.pose_now();
                t.channel(MARKERS_TOPIC)
                    .send(encode_marker_array(stamp, pose, phase));
                t.channel(MARKER_TOPIC)
                    .send(encode_single_marker(stamp, pose, phase));
                t.channel(AMCL_POSE_TOPIC)
                    .send(encode_amcl_pose(stamp, pose, phase));
                t.channel(GRID_CELLS_TOPIC)
                    .send(encode_grid_cells(stamp, phase));
            }
        });
        let t = this.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(50));
            let mut phase = 0u32;
            loop {
                tick.tick().await;
                phase = phase.wrapping_add(1);
                let (stamp, pose) = t.pose_now();
                t.channel(ODOM_TOPIC).send(encode_odometry(stamp, pose));
                if phase.is_multiple_of(2) {
                    t.channel(RANGE_TOPIC).send(encode_range(stamp, pose));
                }
                if phase.is_multiple_of(4) {
                    t.channel(FOOTPRINT_TOPIC).send(encode_footprint(stamp));
                }
                if phase.is_multiple_of(10) {
                    t.channel(POINT_TOPIC)
                        .send(encode_point_stamped(stamp, pose, phase));
                }
                if phase.is_multiple_of(4)
                    && t.channel(IMAGE_TOPIC).tx.receiver_count()
                        + t.channel(DEPTH_TOPIC).tx.receiver_count()
                        > 0
                {
                    let (rgb, depth) =
                        tokio::task::spawn_blocking(move || encode_camera_images(stamp, pose))
                            .await
                            .unwrap_or_default();
                    t.channel(IMAGE_TOPIC).send(rgb);
                    t.channel(DEPTH_TOPIC).send(depth);
                }
                if phase.is_multiple_of(4) {
                    t.channel(CAMERA_INFO_TOPIC).send(encode_camera_info(stamp));
                }
            }
        });
        let t = this.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            loop {
                tick.tick().await;
                let (stamp, pose) = t.pose_now();
                t.channel(PATH_TOPIC).send(encode_path(stamp, pose));
                t.channel(GOAL_TOPIC).send(encode_goal(stamp, pose));
                t.channel(PARTICLE_TOPIC)
                    .send(encode_particles(stamp, pose));
            }
        });

        let t = this.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            let mut phase = 0u32;
            loop {
                tick.tick().await;
                phase = phase.wrapping_add(1);
                let (stamp, pose) = t.pose_now();
                t.channel(SCAN_TOPIC).send(encode_scan(stamp, pose));
                if t.channel(LIVOX_TOPIC).tx.receiver_count() > 0 {
                    t.channel(LIVOX_TOPIC)
                        .send(encode_livox(stamp, pose, phase));
                }
            }
        });
        let t = this.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(33));
            loop {
                tick.tick().await;
                let (stamp, pose) = t.pose_now();
                t.channel(TF_TOPIC).send(encode_tf(stamp, pose));
            }
        });
        let t = this.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tick.tick().await;
                t.channel(CLOCK_TOPIC).send(encode_clock(now_stamp()));
            }
        });
        this
    }

    fn channel(&self, topic: &str) -> &Channel {
        &self.channels[topic]
    }

    fn pose_now(&self) -> (Stamp, Pose2D) {
        let t = self.start.elapsed().unwrap_or_default().as_secs_f64();
        let a = t / CIRCLE_PERIOD_S * std::f64::consts::TAU;
        (
            now_stamp(),
            Pose2D {
                x: CIRCLE_RADIUS * a.cos(),
                y: CIRCLE_RADIUS * a.sin(),
                yaw: a + std::f64::consts::FRAC_PI_2,
            },
        )
    }
}

impl Channel {
    fn send(&self, bytes: Vec<u8>) {
        let b = Bytes::from(bytes);
        *self.latched.lock().unwrap() = Some(b.clone());
        let _ = self.tx.send(b); // no receivers is fine
    }
}

impl Transport for MockTransport {
    fn ros_distro(&self) -> Option<String> {
        None
    }

    fn list_topics(&self) -> Result<Vec<TopicInfo>, TransportError> {
        let mut topics: Vec<TopicInfo> = self
            .channels
            .iter()
            .map(|(name, ch)| TopicInfo {
                name: (*name).into(),
                types: vec![ch.type_name.into()],
            })
            .collect();
        for (name, ty) in self.published.lock().unwrap().iter() {
            topics.push(TopicInfo {
                name: name.clone(),
                types: vec![ty.clone()],
            });
        }
        topics.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(topics)
    }

    fn subscribe_raw(
        &self,
        topic: &str,
        type_name: &str,
        qos: QosProfile,
    ) -> Result<RawMessageStream, TransportError> {
        let Some(ch) = self.channels.get(topic) else {
            // Unknown topic: a valid subscription that never receives anything, like ROS.
            let (_tx, rx) = broadcast::channel::<Bytes>(1);
            return Ok(Box::pin(BroadcastStream::new(rx).filter_map(Result::ok)));
        };
        if ch.type_name != type_name {
            return Err(TransportError::UnknownType(type_name.into()));
        }
        let rx = ch.tx.subscribe();
        let latched =
            if qos.durability == webrvizlite_core::protocol::DurabilityPolicy::TransientLocal {
                ch.latched.lock().unwrap().clone()
            } else {
                None
            };
        let live = BroadcastStream::new(rx).filter_map(Result::ok);
        Ok(Box::pin(tokio_stream::iter(latched).chain(live)))
    }

    fn publish_json(
        &self,
        topic: &str,
        type_name: &str,
        _qos: QosProfile,
        msg: &serde_json::Value,
    ) -> Result<(), TransportError> {
        tracing::info!(topic, type_name, %msg, "mock publish");
        self.published
            .lock()
            .unwrap()
            .insert(topic.into(), type_name.into());
        Ok(())
    }

    fn now(&self) -> RosTimeNs {
        wall_now_ns()
    }

    fn use_sim_time(&self) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------
// Scene + encoders
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Stamp {
    sec: i32,
    nanosec: u32,
}

#[derive(Clone, Copy)]
struct Pose2D {
    x: f64,
    y: f64,
    yaw: f64,
}

pub fn wall_now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

fn now_stamp() -> Stamp {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Stamp {
        sec: d.as_secs() as i32,
        nanosec: d.subsec_nanos(),
    }
}

fn header(w: &mut Writer, stamp: Stamp, frame_id: &str) {
    w.i32(stamp.sec).u32(stamp.nanosec).string(frame_id);
}

/// Distance from `(x, y)` along direction `theta` to the room walls.
fn ray_to_walls(x: f64, y: f64, theta: f64) -> f64 {
    let (dx, dy) = (theta.cos(), theta.sin());
    let mut best = f64::INFINITY;
    if dx.abs() > 1e-9 {
        let wall = if dx > 0.0 { ROOM_HALF_X } else { -ROOM_HALF_X };
        best = best.min((wall - x) / dx);
    }
    if dy.abs() > 1e-9 {
        let wall = if dy > 0.0 { ROOM_HALF_Y } else { -ROOM_HALF_Y };
        best = best.min((wall - y) / dy);
    }
    best
}

fn encode_scan(stamp: Stamp, pose: Pose2D) -> Vec<u8> {
    let mut w = Writer::with_capacity(64 + BEAMS * 8);
    header(&mut w, stamp, "laser");
    let angle_min = -std::f64::consts::PI as f32;
    let angle_max = std::f64::consts::PI as f32;
    let inc = (angle_max - angle_min) / BEAMS as f32;
    w.f32(angle_min)
        .f32(angle_max)
        .f32(inc)
        .f32(0.0)
        .f32(0.1)
        .f32(0.05)
        .f32(12.0);
    // laser is 0.2 m ahead of base_link (see tf_static)
    let lx = pose.x + 0.2 * pose.yaw.cos();
    let ly = pose.y + 0.2 * pose.yaw.sin();
    w.seq_len(BEAMS);
    let mut intensities = Vec::with_capacity(BEAMS);
    for i in 0..BEAMS {
        let a = angle_min as f64 + (i as f64 + 0.5) * inc as f64 + pose.yaw;
        let r = ray_to_walls(lx, ly, a);
        // tiny deterministic jitter so the cloud is not perfectly flat
        let jitter = ((i as f64 * 0.37 + stamp.nanosec as f64 * 1e-9).sin()) * 0.01;
        w.f32((r + jitter) as f32);
        intensities.push(100.0 + 50.0 * (a * 3.0).sin() as f32);
    }
    w.f32_seq(&intensities);
    w.finish()
}

fn transform(w: &mut Writer, stamp: Stamp, parent: &str, child: &str, t: [f64; 3], q: [f64; 4]) {
    header(w, stamp, parent);
    w.string(child);
    for v in t {
        w.f64(v);
    }
    for v in q {
        w.f64(v);
    }
}

fn yaw_quat(yaw: f64) -> [f64; 4] {
    [0.0, 0.0, (yaw / 2.0).sin(), (yaw / 2.0).cos()]
}

fn encode_tf(stamp: Stamp, pose: Pose2D) -> Vec<u8> {
    let mut w = Writer::new();
    w.seq_len(2);
    transform(
        &mut w,
        stamp,
        "map",
        "odom",
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    );
    // base_footprint → base_link is static (robot_state_publisher style), see encode_tf_static.
    transform(
        &mut w,
        stamp,
        "odom",
        "base_footprint",
        [pose.x, pose.y, 0.0],
        yaw_quat(pose.yaw),
    );
    w.finish()
}

/// sensor_msgs/CameraInfo for the synthetic camera (plumb_bob, no distortion).
fn encode_camera_info(stamp: Stamp) -> Vec<u8> {
    let mut w = Writer::with_capacity(400);
    header(&mut w, stamp, "camera_optical_frame");
    w.u32(CAM_H as u32).u32(CAM_W as u32).string("plumb_bob");
    w.seq_len(5);
    for _ in 0..5 {
        w.f64(0.0);
    }
    let (cx, cy) = (CAM_W as f64 / 2.0, CAM_H as f64 / 2.0);
    for v in [CAM_F, 0.0, cx, 0.0, CAM_F, cy, 0.0, 0.0, 1.0] {
        w.f64(v);
    }
    for i in 0..9 {
        w.f64(if i % 4 == 0 { 1.0 } else { 0.0 });
    }
    for v in [CAM_F, 0.0, cx, 0.0, 0.0, CAM_F, cy, 0.0, 0.0, 0.0, 1.0, 0.0] {
        w.f64(v);
    }
    w.u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).bool(false);
    w.finish()
}

/// Ray-casts the room from the robot's camera (base_link + (0.28, 0, 0.4), looking
/// along +x): an rgb8 colour image (walls, chequered floor, ceiling, the map pillar)
/// and a 16UC1 depth image in millimetres. Same intrinsics as `encode_camera_info`.
fn encode_camera_images(stamp: Stamp, robot: Pose2D) -> (Vec<u8>, Vec<u8>) {
    let (cx, cy) = (CAM_W as f64 / 2.0, CAM_H as f64 / 2.0);
    let cam_x = robot.x + 0.28 * robot.yaw.cos();
    let cam_y = robot.y + 0.28 * robot.yaw.sin();
    let cam_z = 0.4;
    let mut rgb = vec![0u8; CAM_W * CAM_H * 3];
    let mut depth = vec![0u8; CAM_W * CAM_H * 2];
    for v in 0..CAM_H {
        for u in 0..CAM_W {
            // Optical frame: x right, y down, z forward → camera_link: x fwd, y left, z up.
            let dx_o = (u as f64 + 0.5 - cx) / CAM_F;
            let dy_o = (v as f64 + 0.5 - cy) / CAM_F;
            let norm = (dx_o * dx_o + dy_o * dy_o + 1.0).sqrt();
            let (fwd, left, up) = (1.0 / norm, -dx_o / norm, -dy_o / norm);
            let wx = fwd * robot.yaw.cos() - left * robot.yaw.sin();
            let wy = fwd * robot.yaw.sin() + left * robot.yaw.cos();
            let wz = up;
            // Candidate hits: floor (z = 0), ceiling, walls, pillar.
            let mut t = f64::INFINITY;
            let mut color = [40u8, 40, 48];
            if wz < -1e-6 {
                let tf = -cam_z / wz;
                let (hx, hy) = (cam_x + wx * tf, cam_y + wy * tf);
                let check = ((hx.floor() as i64 + hy.floor() as i64) & 1) == 0;
                t = tf;
                color = if check {
                    [200, 200, 200]
                } else {
                    [150, 150, 160]
                };
            } else if wz > 1e-6 {
                t = (ROOM_CEILING - cam_z) / wz;
                color = [70, 70, 80];
            }
            let horiz = (wx * wx + wy * wy).sqrt();
            if horiz > 1e-9 {
                let dist = ray_to_walls(cam_x, cam_y, wy.atan2(wx));
                let tw = dist / horiz;
                if tw < t {
                    t = tw;
                    let (hx, hy) = (cam_x + wx * tw, cam_y + wy * tw);
                    let stripe = (((hx + hy) * 2.0).floor() as i64 & 1) == 0;
                    color = if stripe {
                        [120, 150, 200]
                    } else {
                        [90, 110, 160]
                    };
                }
                // pillar at (2.5, -1.5), r 0.3, 1.2 m tall
                let (px, py, pr) = (2.5, -1.5, 0.3);
                let (ox, oy) = (cam_x - px, cam_y - py);
                let b = ox * wx + oy * wy;
                let c = ox * ox + oy * oy - pr * pr;
                let disc = b * b - c * horiz * horiz;
                if disc > 0.0 {
                    let tp = (-b - disc.sqrt()) / (horiz * horiz);
                    if tp > 0.0 && tp < t && cam_z + wz * tp <= 1.2 {
                        t = tp;
                        color = [200, 90, 60];
                    }
                }
            }
            let i = v * CAM_W + u;
            rgb[i * 3..i * 3 + 3].copy_from_slice(&color);
            // Depth along the optical axis (z), in mm; 0 = no return.
            let z_mm = if t.is_finite() {
                (t * fwd * 1000.0).min(65535.0) as u16
            } else {
                0
            };
            depth[i * 2..i * 2 + 2].copy_from_slice(&z_mm.to_le_bytes());
        }
    }
    (
        encode_image(stamp, "rgb8", 3, &rgb),
        encode_image(stamp, "16UC1", 2, &depth),
    )
}

fn encode_image(stamp: Stamp, encoding: &str, bpp: usize, data: &[u8]) -> Vec<u8> {
    let mut w = Writer::with_capacity(data.len() + 64);
    header(&mut w, stamp, "camera_optical_frame");
    w.u32(CAM_H as u32)
        .u32(CAM_W as u32)
        .string(encoding)
        .u8(0)
        .u32((CAM_W * bpp) as u32);
    w.seq_len(data.len()).bytes(data);
    w.finish()
}

fn encode_string(s: &str) -> Vec<u8> {
    let mut w = Writer::with_capacity(s.len() + 8);
    w.string(s);
    w.finish()
}

fn encode_tf_static(stamp: Stamp) -> Vec<u8> {
    let mut w = Writer::new();
    w.seq_len(8);
    let identity = [0.0, 0.0, 0.0, 1.0];
    // Robot links (see fixtures/robot_description/tier1_robot.urdf joints).
    transform(
        &mut w,
        stamp,
        "base_footprint",
        "base_link",
        [0.0; 3],
        identity,
    );
    transform(
        &mut w,
        stamp,
        "base_link",
        "wheel_left_link",
        [0.0, 0.28, 0.127],
        identity,
    );
    transform(
        &mut w,
        stamp,
        "base_link",
        "wheel_right_link",
        [0.0, -0.28, 0.127],
        identity,
    );
    transform(
        &mut w,
        stamp,
        "base_link",
        "caster_front_link",
        [0.22, 0.0, 0.05],
        identity,
    );
    transform(
        &mut w,
        stamp,
        "base_link",
        "camera_link",
        [0.28, 0.0, 0.4],
        identity,
    );
    // Optical frame: z forward, x right, y down (rpy -90°, 0, -90°).
    transform(
        &mut w,
        stamp,
        "camera_link",
        "camera_optical_frame",
        [0.0; 3],
        [-0.5, 0.5, -0.5, 0.5],
    );
    transform(
        &mut w,
        stamp,
        "base_link",
        "laser",
        [0.2, 0.0, 0.3],
        [0.0, 0.0, 0.0, 1.0],
    );
    transform(
        &mut w,
        stamp,
        "base_link",
        "livox_frame",
        [0.0, 0.0, LIVOX_HEIGHT],
        [0.0, 0.0, 0.0, 1.0],
    );
    w.finish()
}

/// livox_ros_driver2/CustomMsg in `livox_frame`: a non-repetitive rosette scan of
/// the room (walls, floor, ceiling) with reflectivity per surface, four laser
/// lines, Livox tags, and every 97th beam a (0, 0, 0) no-return point.
fn encode_livox(stamp: Stamp, pose: Pose2D, phase: u32) -> Vec<u8> {
    const STRIDE: usize = 20;
    let n = LIVOX_POINTS;
    let mut w = Writer::with_capacity(n * STRIDE + 64);
    header(&mut w, stamp, "livox_frame");
    let timebase = stamp.sec as u64 * 1_000_000_000 + stamp.nanosec as u64;
    w.u64(timebase).u32(n as u32).u8(0);
    w.bytes(&[0, 0, 0]);
    w.seq_len(n);
    let t = phase as f64 * 0.1;
    let golden = std::f64::consts::PI * (3.0 - 5f64.sqrt());
    for i in 0..n {
        let f = i as f64;
        let az = (f * golden + t * 0.7) % std::f64::consts::TAU;
        // Elevation sweeps -40°..+40° in a slow sinusoid, like a Mid-360 rosette.
        let el = 0.7 * (f * 0.0137 + t).sin();
        let (sin_el, cos_el) = el.sin_cos();
        let d_wall = ray_to_walls(pose.x, pose.y, pose.yaw + az);
        // Horizontal distance to floor / ceiling along this beam.
        let d_vert = if el < -1e-3 {
            LIVOX_HEIGHT / (-el).tan()
        } else if el > 1e-3 {
            (ROOM_CEILING - LIVOX_HEIGHT) / el.tan()
        } else {
            f64::INFINITY
        };
        let (d, reflectivity) = if d_vert < d_wall {
            (d_vert, if el < 0.0 { 60u8 } else { 90 })
        } else {
            (d_wall, 150)
        };
        let range = d / cos_el; // slant range
        let no_return = i % 97 == 0;
        let (x, y, z) = if no_return {
            (0.0, 0.0, 0.0)
        } else {
            (
                range * cos_el * az.cos(),
                range * cos_el * az.sin(),
                range * sin_el,
            )
        };
        let offset_ns = (f * 100_000_000.0 / n as f64) as u32;
        w.u32(offset_ns);
        w.f32(x as f32).f32(y as f32).f32(z as f32);
        let noise = ((i * 7919) % 23) as u8;
        w.bytes(&[
            if no_return { 0 } else { reflectivity + noise },
            if i % 13 == 0 { 16 } else { 0 }, // tag: occasional "noise" flag
            (i % 4) as u8,                    // line 0..3
        ]);
    }
    w.finish()
}

fn pose(w: &mut Writer, x: f64, y: f64, yaw: f64) {
    w.f64(x).f64(y).f64(0.0);
    for v in yaw_quat(yaw) {
        w.f64(v);
    }
}

/// Occupancy grid of the room: walls occupied (100), inside free (0), a 1 m
/// unknown (-1) border outside.
fn encode_map(stamp: Stamp) -> Vec<u8> {
    let border = 1.0;
    let w_cells = (((ROOM_HALF_X + border) * 2.0) / MAP_RESOLUTION) as u32;
    let h_cells = (((ROOM_HALF_Y + border) * 2.0) / MAP_RESOLUTION) as u32;
    let mut w = Writer::with_capacity((w_cells * h_cells) as usize + 128);
    header(&mut w, stamp, "map");
    w.i32(stamp.sec).u32(stamp.nanosec);
    w.f32(MAP_RESOLUTION as f32).u32(w_cells).u32(h_cells);
    pose(
        &mut w,
        -(ROOM_HALF_X + border),
        -(ROOM_HALF_Y + border),
        0.0,
    );
    w.seq_len((w_cells * h_cells) as usize);
    let mut data = Vec::with_capacity((w_cells * h_cells) as usize);
    for j in 0..h_cells {
        for i in 0..w_cells {
            let x = -(ROOM_HALF_X + border) + (i as f64 + 0.5) * MAP_RESOLUTION;
            let y = -(ROOM_HALF_Y + border) + (j as f64 + 0.5) * MAP_RESOLUTION;
            let inside = x.abs() < ROOM_HALF_X && y.abs() < ROOM_HALF_Y;
            let wall = !inside && x.abs() < ROOM_HALF_X + 0.1 && y.abs() < ROOM_HALF_Y + 0.1;
            // a pillar in the room for costmap-style gradients
            let pillar = ((x - 2.5).powi(2) + (y + 1.5).powi(2)).sqrt();
            data.push(if wall {
                100
            } else if inside {
                if pillar < 0.3 {
                    100
                } else if pillar < 0.9 {
                    (99.0 * (1.0 - (pillar - 0.3) / 0.6)) as u8
                } else {
                    0
                }
            } else {
                255
            });
        }
    }
    w.bytes(&data);
    w.finish()
}

/// The planned path: the rest of the circle ahead of the robot.
fn encode_path(stamp: Stamp, current: Pose2D) -> Vec<u8> {
    const N: usize = 40;
    let mut w = Writer::with_capacity(N * 80);
    header(&mut w, stamp, "map");
    w.seq_len(N);
    let a0 = current.yaw - std::f64::consts::FRAC_PI_2;
    for i in 0..N {
        let a = a0 + (i as f64) / (N as f64) * std::f64::consts::PI;
        header(&mut w, stamp, "map");
        pose(
            &mut w,
            CIRCLE_RADIUS * a.cos(),
            CIRCLE_RADIUS * a.sin(),
            a + std::f64::consts::FRAC_PI_2,
        );
    }
    w.finish()
}

fn covariance(w: &mut Writer, diag: [f64; 6], xy: f64) {
    for (r, d) in diag.iter().enumerate() {
        for c in 0..6 {
            let v = if r == c {
                *d
            } else if (r == 0 && c == 1) || (r == 1 && c == 0) {
                xy
            } else {
                0.0
            };
            w.f64(v);
        }
    }
}

/// nav_msgs/Odometry of the circling robot (odom → base_link) with a 2-D covariance.
fn encode_odometry(stamp: Stamp, current: Pose2D) -> Vec<u8> {
    let mut w = Writer::with_capacity(700);
    header(&mut w, stamp, "odom");
    w.string("base_link");
    pose(&mut w, current.x, current.y, current.yaw);
    covariance(&mut w, [0.02, 0.02, 0.0, 0.0, 0.0, 0.01], 0.0);
    let v = CIRCLE_RADIUS * std::f64::consts::TAU / CIRCLE_PERIOD_S;
    for val in [
        v,
        0.0,
        0.0,
        0.0,
        0.0,
        std::f64::consts::TAU / CIRCLE_PERIOD_S,
    ] {
        w.f64(val);
    }
    covariance(&mut w, [0.001; 6], 0.0);
    w.finish()
}

/// geometry_msgs/PoseWithCovarianceStamped near the robot with a full 3-D covariance.
fn encode_amcl_pose(stamp: Stamp, current: Pose2D, phase: u32) -> Vec<u8> {
    let mut w = Writer::with_capacity(400);
    header(&mut w, stamp, "map");
    let wobble = (phase as f64 * 0.7).sin() * 0.05;
    pose(
        &mut w,
        current.x + wobble,
        current.y - wobble,
        current.yaw + 0.05 * wobble,
    );
    covariance(&mut w, [0.05, 0.08, 0.01, 0.01, 0.02, 0.05], 0.02);
    w.finish()
}

/// geometry_msgs/PointStamped orbiting the goal.
fn encode_point_stamped(stamp: Stamp, current: Pose2D, phase: u32) -> Vec<u8> {
    let mut w = Writer::with_capacity(64);
    header(&mut w, stamp, "map");
    let a = current.yaw - std::f64::consts::FRAC_PI_2 + std::f64::consts::PI;
    let t = phase as f64 * 0.3;
    w.f64(CIRCLE_RADIUS * a.cos() + 0.5 * t.cos())
        .f64(CIRCLE_RADIUS * a.sin() + 0.5 * t.sin())
        .f64(0.3 + 0.1 * (2.0 * t).sin());
    w.finish()
}

/// geometry_msgs/PolygonStamped: the robot footprint (0.6 × 0.5 m, rounded) in base_link.
fn encode_footprint(stamp: Stamp) -> Vec<u8> {
    let mut w = Writer::with_capacity(160);
    header(&mut w, stamp, "base_link");
    let pts: [(f32, f32); 8] = [
        (0.30, 0.20),
        (0.25, 0.25),
        (-0.25, 0.25),
        (-0.30, 0.20),
        (-0.30, -0.20),
        (-0.25, -0.25),
        (0.25, -0.25),
        (0.30, -0.20),
    ];
    w.seq_len(pts.len());
    for (x, y) in pts {
        w.f32(x).f32(y).f32(0.0);
    }
    w.finish()
}

/// nav_msgs/GridCells: a pulsing ring of 0.1 m cells around the room centre.
fn encode_grid_cells(stamp: Stamp, phase: u32) -> Vec<u8> {
    let mut w = Writer::with_capacity(8000);
    header(&mut w, stamp, "map");
    w.f32(0.1).f32(0.1);
    let r0 = 1.0 + 0.3 * (phase as f64 * 0.5).sin();
    let mut cells: Vec<(f32, f32)> = Vec::new();
    for i in -20..20 {
        for j in -20..20 {
            let x = i as f64 * 0.1 + 0.05;
            let y = j as f64 * 0.1 + 0.05;
            let d = (x * x + y * y).sqrt();
            if d >= r0 && d < r0 + 0.25 {
                cells.push((x as f32, y as f32));
            }
        }
    }
    w.seq_len(cells.len());
    for (x, y) in cells {
        w.f32(x).f32(y).f32(0.0);
    }
    w.finish()
}

/// sensor_msgs/Range from the laser frame straight ahead (ultrasound, 0.5 rad cone).
fn encode_range(stamp: Stamp, current: Pose2D) -> Vec<u8> {
    let mut w = Writer::with_capacity(64);
    header(&mut w, stamp, "laser");
    let lx = current.x + 0.2 * current.yaw.cos();
    let ly = current.y + 0.2 * current.yaw.sin();
    let r = ray_to_walls(lx, ly, current.yaw).min(4.0);
    w.u8(0).f32(0.5).f32(0.05).f32(4.0).f32(r as f32);
    w.finish()
}

fn encode_goal(stamp: Stamp, current: Pose2D) -> Vec<u8> {
    let mut w = Writer::new();
    header(&mut w, stamp, "map");
    let a = current.yaw - std::f64::consts::FRAC_PI_2 + std::f64::consts::PI;
    pose(
        &mut w,
        CIRCLE_RADIUS * a.cos(),
        CIRCLE_RADIUS * a.sin(),
        a + std::f64::consts::FRAC_PI_2,
    );
    w.finish()
}

/// Particle cloud around the robot (odom frame to exercise the transform path).
fn encode_particles(stamp: Stamp, current: Pose2D) -> Vec<u8> {
    const N: usize = 60;
    let mut w = Writer::with_capacity(N * 56 + 64);
    header(&mut w, stamp, "odom");
    w.seq_len(N);
    for i in 0..N {
        let a = (i as f64) * 2.399; // golden angle spread
        let r = 0.05 + 0.25 * ((i as f64) / N as f64);
        pose(
            &mut w,
            current.x + r * a.cos(),
            current.y + r * a.sin(),
            current.yaw + 0.3 * (a * 0.5).sin(),
        );
    }
    w.finish()
}

/// Dense PointCloud2 (x y z intensity rgb, 20-byte points) in the `laser` frame:
/// a rippling height field around the robot, moving with `phase`.
fn encode_points(stamp: Stamp, phase: u32) -> Vec<u8> {
    const STEP: usize = 20;
    let side = (POINTS_COUNT as f64).sqrt() as usize; // ~547 × 547 grid
    let n = side * side;
    let mut w = Writer::with_capacity(n * STEP + 256);
    header(&mut w, stamp, "laser");
    w.u32(1).u32(n as u32);
    w.seq_len(5);
    for (name, offset, datatype) in [
        ("x", 0u32, 7u8),
        ("y", 4, 7),
        ("z", 8, 7),
        ("intensity", 12, 7),
        ("rgb", 16, 7),
    ] {
        w.string(name).u32(offset).u8(datatype).u32(1);
    }
    w.bool(false).u32(STEP as u32).u32((STEP * n) as u32);
    w.seq_len(n * STEP);
    let t = phase as f64 * 0.1;
    let mut buf = Vec::with_capacity(n * STEP);
    for j in 0..side {
        for i in 0..side {
            let x = (i as f64 / side as f64 - 0.5) * 6.0;
            let y = (j as f64 / side as f64 - 0.5) * 6.0;
            let r = (x * x + y * y).sqrt();
            let z = 0.3 * (r * 3.0 - t * 2.0).sin() * (-r * 0.4).exp();
            let intensity = ((z + 0.3) / 0.6 * 255.0) as f32;
            let rgb = (((x + 3.0) / 6.0 * 255.0) as u32) << 16
                | (((y + 3.0) / 6.0 * 255.0) as u32) << 8
                | 128;
            buf.extend_from_slice(&(x as f32).to_le_bytes());
            buf.extend_from_slice(&(y as f32).to_le_bytes());
            buf.extend_from_slice(&(z as f32).to_le_bytes());
            buf.extend_from_slice(&intensity.to_le_bytes());
            buf.extend_from_slice(&rgb.to_le_bytes());
        }
    }
    w.bytes(&buf);
    w.bool(true);
    w.finish()
}

// ---- markers ------------------------------------------------------------

struct MarkerSpec<'a> {
    ns: &'a str,
    id: i32,
    kind: i32,
    action: i32,
    frame: &'a str,
    pose: ([f64; 3], f64),
    scale: [f64; 3],
    color: [f32; 4],
    lifetime_s: i32,
    frame_locked: bool,
    points: &'a [[f32; 3]],
    colors: &'a [[f32; 4]],
    text: &'a str,
    mesh: &'a str,
}

impl Default for MarkerSpec<'_> {
    fn default() -> Self {
        Self {
            ns: "",
            id: 0,
            kind: 1,
            action: 0,
            frame: "map",
            pose: ([0.0; 3], 0.0),
            scale: [0.2, 0.2, 0.2],
            color: [1.0, 1.0, 1.0, 1.0],
            lifetime_s: 0,
            frame_locked: false,
            points: &[],
            colors: &[],
            text: "",
            mesh: "",
        }
    }
}

/// visualization_msgs/Marker, Humble layout.
fn write_marker(w: &mut Writer, stamp: Stamp, m: &MarkerSpec) {
    header(w, stamp, m.frame);
    w.string(m.ns).i32(m.id).i32(m.kind).i32(m.action);
    w.f64(m.pose.0[0]).f64(m.pose.0[1]).f64(m.pose.0[2]);
    for v in yaw_quat(m.pose.1) {
        w.f64(v);
    }
    for v in m.scale {
        w.f64(v);
    }
    for v in m.color {
        w.f32(v);
    }
    w.i32(m.lifetime_s).u32(0);
    w.bool(m.frame_locked);
    w.seq_len(m.points.len());
    for p in m.points {
        w.f64(p[0] as f64).f64(p[1] as f64).f64(p[2] as f64);
    }
    w.seq_len(m.colors.len());
    for c in m.colors {
        for v in c {
            w.f32(*v);
        }
    }
    w.string(""); // texture_resource
    w.i32(0).u32(0).string("").string("").seq_len(0); // texture (CompressedImage)
    w.seq_len(0); // uv_coordinates
    w.string(m.text);
    w.string(m.mesh);
    w.string("").seq_len(0); // mesh_file
    w.bool(false);
}

/// One of every marker type in the "demo" namespace, plus a 5,000-cube grid
/// in "cubes" whose colours cycle, plus a namespace that is DELETEALL'd every
/// other second and a marker with a 1 s lifetime that is only sent every 3 s.
fn encode_marker_array(stamp: Stamp, robot: Pose2D, phase: u32) -> Vec<u8> {
    let mut specs: Vec<MarkerSpec> = Vec::new();
    let base = [-3.5f64, 2.0, 0.5];
    let spot = |i: usize| ([base[0] + i as f64 * 0.6, base[1], base[2]], 0.0);
    let arrow_pts = [[0.0f32, 0.0, 0.0], [0.0, 0.0, 0.5]];
    let strip_pts = [
        [0.0f32, 0.0, 0.0],
        [0.3, 0.0, 0.3],
        [0.6, 0.0, 0.0],
        [0.9, 0.0, 0.3],
    ];
    let list_pts = [
        [0.0f32, 0.0, 0.0],
        [0.0, 0.0, 0.4],
        [0.2, 0.0, 0.0],
        [0.2, 0.0, 0.4],
    ];
    let list_colors = [
        [1.0f32, 0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0, 1.0],
        [0.0, 0.0, 1.0, 1.0],
        [0.0, 0.0, 1.0, 1.0],
    ];
    let grid_pts: Vec<[f32; 3]> = (0..27)
        .map(|i| {
            [
                (i % 3) as f32 * 0.15,
                (i / 3 % 3) as f32 * 0.15,
                (i / 9) as f32 * 0.15,
            ]
        })
        .collect();
    let grid_colors: Vec<[f32; 4]> = (0..27)
        .map(|i| {
            [
                (i % 3) as f32 / 2.0,
                (i / 3 % 3) as f32 / 2.0,
                (i / 9) as f32 / 2.0,
                1.0,
            ]
        })
        .collect();
    let tri_pts = [
        [0.0f32, 0.0, 0.0],
        [0.4, 0.0, 0.0],
        [0.2, 0.0, 0.4],
        [0.4, 0.0, 0.0],
        [0.8, 0.0, 0.0],
        [0.6, 0.0, 0.4],
    ];
    specs.push(MarkerSpec {
        ns: "demo",
        id: 0,
        kind: 0,
        pose: spot(0),
        scale: [0.5, 0.05, 0.05],
        color: [1.0, 0.0, 0.0, 1.0],
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 1,
        kind: 0,
        pose: spot(1),
        scale: [0.05, 0.1, 0.1],
        color: [1.0, 0.5, 0.0, 1.0],
        points: &arrow_pts,
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 2,
        kind: 1,
        pose: spot(2),
        color: [0.0, 1.0, 0.0, 1.0],
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 3,
        kind: 2,
        pose: spot(3),
        color: [0.0, 0.5, 1.0, 1.0],
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 4,
        kind: 3,
        pose: spot(4),
        scale: [0.2, 0.2, 0.4],
        color: [1.0, 1.0, 0.0, 1.0],
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 5,
        kind: 4,
        pose: spot(5),
        scale: [0.03, 0.0, 0.0],
        color: [1.0, 0.0, 1.0, 1.0],
        points: &strip_pts,
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 6,
        kind: 5,
        pose: spot(7),
        scale: [0.03, 0.0, 0.0],
        points: &list_pts,
        colors: &list_colors,
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 7,
        kind: 6,
        pose: spot(8),
        scale: [0.1, 0.1, 0.1],
        points: &grid_pts,
        colors: &grid_colors,
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 8,
        kind: 7,
        pose: spot(9),
        scale: [0.1, 0.1, 0.1],
        color: [0.0, 1.0, 1.0, 1.0],
        points: &grid_pts,
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 9,
        kind: 8,
        pose: spot(10),
        scale: [0.05, 0.05, 0.0],
        color: [1.0, 1.0, 1.0, 1.0],
        points: &grid_pts,
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 10,
        kind: 9,
        pose: spot(11),
        scale: [0.0, 0.0, 0.25],
        color: [1.0, 1.0, 1.0, 1.0],
        text: "TEXT_VIEW_FACING",
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 11,
        kind: 10,
        pose: spot(12),
        scale: [1.0, 1.0, 1.0],
        color: [0.8, 0.8, 0.8, 1.0],
        mesh: "package://nonexistent_pkg/meshes/robot.dae",
        ..Default::default()
    });
    specs.push(MarkerSpec {
        ns: "demo",
        id: 12,
        kind: 11,
        pose: spot(13),
        scale: [1.0, 1.0, 1.0],
        color: [0.2, 0.8, 0.2, 0.7],
        points: &tri_pts,
        ..Default::default()
    });
    // frame-locked cube riding on base_link
    specs.push(MarkerSpec {
        ns: "demo",
        id: 13,
        kind: 1,
        frame: "base_link",
        pose: ([0.0, 0.0, 0.6], 0.0),
        scale: [0.15, 0.15, 0.15],
        color: [1.0, 0.3, 0.3, 1.0],
        frame_locked: true,
        ..Default::default()
    });
    // invalid marker: NaN scale → must be rejected without breaking the rest
    specs.push(MarkerSpec {
        ns: "demo",
        id: 14,
        kind: 1,
        pose: spot(14),
        scale: [f64::NAN, 0.2, 0.2],
        ..Default::default()
    });
    // lifetime marker: sent every 3 s with a 1 s lifetime → blinks
    if phase.is_multiple_of(3) {
        specs.push(MarkerSpec {
            ns: "lifetime",
            id: 0,
            kind: 2,
            pose: ([robot.x, robot.y, 1.0], 0.0),
            scale: [0.3, 0.3, 0.3],
            color: [1.0, 1.0, 0.0, 1.0],
            lifetime_s: 1,
            ..Default::default()
        });
    }
    // DELETEALL namespace toggling every 2 s
    if phase % 4 < 2 {
        specs.push(MarkerSpec {
            ns: "toggle",
            id: 0,
            kind: 3,
            pose: ([3.5, 2.5, 0.3], 0.0),
            scale: [0.3, 0.3, 0.6],
            color: [0.5, 0.0, 1.0, 1.0],
            ..Default::default()
        });
    } else {
        specs.push(MarkerSpec {
            ns: "toggle",
            id: 0,
            action: 2,
            ..Default::default()
        });
    }
    // DELETEALL (wipes every marker in the display) every 20 s
    if phase.is_multiple_of(20) {
        specs.insert(
            0,
            MarkerSpec {
                ns: "",
                id: 0,
                action: 3,
                ..Default::default()
            },
        );
    }
    // 5,000 cubes
    let side = 71; // 71² = 5041 ≥ 5000
    let cube_specs: Vec<MarkerSpec> = (0..CUBE_MARKERS)
        .map(|i| {
            let (x, y) = ((i % side) as f64, (i / side) as f64);
            let hue = ((i as f64 * 0.013 + phase as f64 * 0.1) % 1.0) as f32;
            MarkerSpec {
                ns: "cubes",
                id: i as i32,
                kind: 1,
                pose: (
                    [
                        x * 0.1 - 3.5,
                        y * 0.1 - 3.5,
                        1.5 + 0.2 * ((x + phase as f64) * 0.3).sin(),
                    ],
                    0.0,
                ),
                scale: [0.06, 0.06, 0.06],
                color: [hue, 1.0 - hue, 0.5, 1.0],
                ..Default::default()
            }
        })
        .collect();
    let mut w = Writer::with_capacity((specs.len() + cube_specs.len()) * 200);
    w.seq_len(specs.len() + cube_specs.len());
    for m in specs.iter().chain(cube_specs.iter()) {
        write_marker(&mut w, stamp, m);
    }
    w.finish()
}

fn encode_single_marker(stamp: Stamp, robot: Pose2D, phase: u32) -> Vec<u8> {
    let mut w = Writer::new();
    let spec = MarkerSpec {
        ns: "single",
        id: 1,
        kind: 9,
        pose: ([robot.x, robot.y, 0.8], 0.0),
        scale: [0.0, 0.0, 0.2],
        color: [1.0, 1.0, 1.0, 1.0],
        text: if phase.is_multiple_of(2) {
            "robot"
        } else {
            "ROBOT"
        },
        ..Default::default()
    };
    write_marker(&mut w, stamp, &spec);
    w.finish()
}

fn encode_clock(stamp: Stamp) -> Vec<u8> {
    let mut w = Writer::new();
    w.i32(stamp.sec).u32(stamp.nanosec);
    w.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use webrvizlite_core::cdr::Reader;

    #[test]
    fn scan_decodes_with_expected_layout() {
        let bytes = encode_scan(
            Stamp { sec: 1, nanosec: 2 },
            Pose2D {
                x: 0.0,
                y: 0.0,
                yaw: 0.0,
            },
        );
        let mut r = Reader::new(&bytes).unwrap();
        assert_eq!(r.i32().unwrap(), 1);
        assert_eq!(r.u32().unwrap(), 2);
        assert_eq!(r.str().unwrap(), "laser");
        let angle_min = r.f32().unwrap();
        let _angle_max = r.f32().unwrap();
        let _inc = r.f32().unwrap();
        let _time_inc = r.f32().unwrap();
        let _scan_time = r.f32().unwrap();
        let range_min = r.f32().unwrap();
        let range_max = r.f32().unwrap();
        assert!(angle_min < 0.0 && range_min < range_max);
        let mut ranges = Vec::new();
        r.f32_seq_into(&mut ranges).unwrap();
        assert_eq!(ranges.len(), BEAMS);
        // Beam 0 points along -X from the laser at (0.2, 0): wall at x = -4 → ~4.2 m.
        assert!((ranges[0] - 4.2).abs() < 0.05, "{}", ranges[0]);
        let mut intensities = Vec::new();
        r.f32_seq_into(&mut intensities).unwrap();
        assert_eq!(intensities.len(), BEAMS);
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn livox_decodes_and_drops_no_returns() {
        let bytes = encode_livox(
            Stamp { sec: 1, nanosec: 2 },
            Pose2D {
                x: 0.0,
                y: 0.0,
                yaw: 0.0,
            },
            3,
        );
        assert_eq!(bytes.len(), 4 + 44 + LIVOX_POINTS * 20 - 1);
        let m = webrvizlite_core::msgs::pointcloud::decode_livox_custom_msg(&bytes).unwrap();
        assert_eq!(m.header.frame_id, "livox_frame");
        assert_eq!(m.point_num as usize, LIVOX_POINTS);
        assert_eq!(m.xyz.len(), LIVOX_POINTS * 3);
        let p = webrvizlite_core::pointcloud::points_from_livox(&m);
        let no_returns = LIVOX_POINTS.div_ceil(97);
        assert_eq!(p.len(), LIVOX_POINTS - no_returns);
        // Everything lies inside the room box around the sensor.
        for xyz in p.xyz.chunks(3) {
            assert!(xyz[0].abs() <= 8.1 && xyz[1].abs() <= 6.1, "{xyz:?}");
            assert!(xyz[2] >= -0.51 && xyz[2] <= 2.01, "{xyz:?}");
        }
        // Point 0 is a no-return, so the first surviving points are beams 1 and 2.
        assert_eq!(&p.channel("line").unwrap()[..2], &[1.0, 2.0]);
        assert_eq!(p.channel("intensity").unwrap().len(), p.len());
    }

    #[test]
    fn tier1_messages_decode() {
        use webrvizlite_core::msgs::{geometry, nav, sensor};
        let pose = Pose2D {
            x: 1.0,
            y: 2.0,
            yaw: 0.5,
        };
        let o = nav::decode_odometry(&encode_odometry(now_stamp(), pose)).unwrap();
        assert_eq!(o.child_frame_id, "base_link");
        assert_eq!(o.pose_covariance[0], 0.02);
        let p =
            geometry::decode_pose_with_covariance_stamped(&encode_amcl_pose(now_stamp(), pose, 3))
                .unwrap();
        assert_eq!(p.covariance[1], 0.02);
        assert_eq!(
            geometry::decode_point_stamped(&encode_point_stamped(now_stamp(), pose, 1))
                .unwrap()
                .header
                .frame_id,
            "map"
        );
        assert_eq!(
            geometry::decode_polygon_stamped(&encode_footprint(now_stamp()))
                .unwrap()
                .points
                .len(),
            24
        );
        let g = nav::decode_grid_cells(&encode_grid_cells(now_stamp(), 0)).unwrap();
        assert!(g.cells.len() > 30 && g.cell_width == 0.1);
        let r = sensor::decode_range(&encode_range(now_stamp(), pose)).unwrap();
        assert!(r.range > 0.0 && r.range <= 4.0);
        let (rgb, depth) = encode_camera_images(now_stamp(), pose);
        let img = sensor::decode_image(&rgb).unwrap();
        assert_eq!(
            (
                img.width as usize,
                img.height as usize,
                img.encoding.as_str()
            ),
            (CAM_W, CAM_H, "rgb8")
        );
        let d = sensor::decode_image(&depth).unwrap();
        assert_eq!((d.encoding.as_str(), d.step as usize), ("16UC1", CAM_W * 2));
        let ci = sensor::decode_camera_info(&encode_camera_info(now_stamp())).unwrap();
        assert_eq!(ci.k[0], CAM_F);
    }

    #[test]
    fn tf_decodes() {
        let bytes = encode_tf(
            Stamp { sec: 0, nanosec: 0 },
            Pose2D {
                x: 1.0,
                y: 2.0,
                yaw: 0.0,
            },
        );
        let mut r = Reader::new(&bytes).unwrap();
        assert_eq!(r.seq_len(1).unwrap(), 2);
        for expected in [("map", "odom", 0.0), ("odom", "base_footprint", 1.0)] {
            r.i32().unwrap();
            r.u32().unwrap();
            assert_eq!(r.str().unwrap(), expected.0);
            assert_eq!(r.str().unwrap(), expected.1);
            assert_eq!(r.f64().unwrap(), expected.2);
            for _ in 0..6 {
                r.f64().unwrap();
            }
        }
        assert_eq!(r.remaining(), 0);
    }
}
