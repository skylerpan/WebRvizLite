//! JS-facing API used by the Web Worker. Keep this layer thin: all logic lives
//! in `webrvizlite-core` so it can be unit-tested natively.

// wasm-bindgen's getter_with_clone generates `.clone()` on Copy fields too.
#![allow(clippy::clone_on_copy)]

use wasm_bindgen::prelude::*;
use webrvizlite_core::math::Transform;
use webrvizlite_core::msgs;
use webrvizlite_core::pointcloud::{self, ColorOptions, Transformer};
use webrvizlite_core::tf;
use webrvizlite_core::wire;

/// Crate version, used by the worker to confirm the WASM module loaded.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Decoded binary frame header (spec §4.3).
#[wasm_bindgen]
pub struct FrameHeader {
    pub kind: u8,
    #[wasm_bindgen(js_name = subscriptionId)]
    pub subscription_id: u32,
    /// Exposed to JS as a BigInt.
    #[wasm_bindgen(js_name = receiveTimeNs)]
    pub receive_time_ns: u64,
    /// Byte offset where the CDR payload starts.
    #[wasm_bindgen(js_name = payloadOffset)]
    pub payload_offset: usize,
}

/// Parses the header of a binary frame. Throws on a frame shorter than the header.
#[wasm_bindgen(js_name = parseFrameHeader)]
pub fn parse_frame_header(bytes: &[u8]) -> Result<FrameHeader, JsError> {
    let (h, _payload) =
        wire::FrameHeader::decode(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(FrameHeader {
        kind: h.kind,
        subscription_id: h.subscription_id,
        receive_time_ns: h.receive_time_ns,
        payload_offset: wire::FrameHeader::SIZE,
    })
}

/// Builds a frame with the given header and payload (used by the M0 echo test).
#[wasm_bindgen(js_name = encodeFrame)]
pub fn encode_frame(
    kind: u8,
    subscription_id: u32,
    receive_time_ns: u64,
    payload: &[u8],
) -> Vec<u8> {
    let h = wire::FrameHeader {
        kind,
        subscription_id,
        receive_time_ns,
    };
    let mut out = Vec::with_capacity(wire::FrameHeader::SIZE + payload.len());
    out.extend_from_slice(&h.encode());
    out.extend_from_slice(payload);
    out
}

// ---------------------------------------------------------------------------
// tf2 buffer
// ---------------------------------------------------------------------------

/// Values per frame written by [`TfBuffer::snapshot`].
pub const SNAPSHOT_STRIDE: usize = 9;

/// Client-side tf2 buffer. One instance per worker.
#[wasm_bindgen]
pub struct TfBuffer {
    inner: tf::TfBuffer,
}

#[wasm_bindgen]
impl TfBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new(cache_seconds: f64) -> TfBuffer {
        TfBuffer {
            inner: tf::TfBuffer::new((cache_seconds * 1e9) as u64),
        }
    }

    /// Decodes a tf2_msgs/TFMessage CDR payload and inserts every transform.
    /// Returns the number of transforms accepted; throws on malformed CDR.
    #[wasm_bindgen(js_name = pushTfMessage)]
    pub fn push_tf_message(
        &mut self,
        bytes: &[u8],
        is_static: bool,
        now_ns: u64,
    ) -> Result<u32, JsError> {
        let msgs = msgs::tf::decode_tf_message(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        let mut n = 0;
        for m in msgs {
            if self.inner.insert(
                &m.header.frame_id,
                &m.child_frame_id,
                m.header.stamp.to_ns(),
                m.transform,
                is_static,
                now_ns,
            ) {
                n += 1;
            }
        }
        Ok(n)
    }

    pub fn clear(&mut self) {
        self.inner.clear();
    }

    #[wasm_bindgen(js_name = frameCount)]
    pub fn frame_count(&self) -> usize {
        self.inner.frame_count()
    }

    /// Frame names in index order, JSON-encoded (changes rarely).
    #[wasm_bindgen(js_name = frameNamesJson)]
    pub fn frame_names_json(&self) -> String {
        let names: Vec<&str> = self.inner.frame_names().collect();
        serde_json::to_string(&names).unwrap_or_else(|_| "[]".into())
    }

    /// Parent index of each frame (-1 for roots), in index order.
    #[wasm_bindgen(js_name = parentIndices)]
    pub fn parent_indices(&self) -> Vec<i32> {
        (0..self.inner.frame_count())
            .map(|i| {
                let name = self.inner.frame_name(i).unwrap_or("");
                self.inner
                    .parent_of(name)
                    .and_then(|p| self.inner.frame_index(p))
                    .map(|p| p as i32)
                    .unwrap_or(-1)
            })
            .collect()
    }

    /// Writes, for every frame, `[valid (0/1/2=static), x, y, z, qx, qy, qz, qw, last_update_ns]`
    /// relative to `fixed_frame` at `time_ns` (0 = latest) into `out`
    /// (length ≥ frameCount × 9). Returns the number of frames written.
    pub fn snapshot(&self, fixed_frame: &str, time_ns: u64, out: &mut [f64]) -> usize {
        let n = self.inner.frame_count().min(out.len() / SNAPSHOT_STRIDE);
        for i in 0..n {
            let name = self.inner.frame_name(i).unwrap_or("");
            let o = &mut out[i * SNAPSHOT_STRIDE..(i + 1) * SNAPSHOT_STRIDE];
            match self.inner.lookup(fixed_frame, name, time_ns) {
                Ok(t) => {
                    // 1 = dynamic frame, 2 = static (never times out)
                    o[0] = if self.inner.is_static(name).unwrap_or(false) {
                        2.0
                    } else {
                        1.0
                    };
                    o[1..4].copy_from_slice(&t.t);
                    o[4..8].copy_from_slice(&t.q);
                }
                Err(_) => {
                    o[0] = 0.0;
                    o[1..8].fill(0.0);
                    o[7] = 1.0;
                }
            }
            o[8] = self.inner.last_update_ns(name).unwrap_or(0) as f64;
        }
        n
    }

    /// `[x, y, z, qx, qy, qz, qw]` of `source` in `target`, or undefined.
    pub fn lookup(&self, target: &str, source: &str, time_ns: u64) -> Option<Box<[f64]>> {
        self.inner
            .lookup(target, source, time_ns)
            .ok()
            .map(|t| transform_to_vec(&t).into_boxed_slice())
    }

    #[wasm_bindgen(js_name = canTransform)]
    pub fn can_transform(&self, target: &str, source: &str, time_ns: u64) -> bool {
        self.inner.can_transform(target, source, time_ns)
    }
}

fn transform_to_vec(t: &Transform) -> Vec<f64> {
    vec![t.t[0], t.t[1], t.t[2], t.q[0], t.q[1], t.q[2], t.q[3]]
}

// ---------------------------------------------------------------------------
// Message decoders (M4+). Each returns a small struct of numbers/strings plus
// typed arrays; the worker posts them to the main thread as transferables.
// ---------------------------------------------------------------------------

/// Result of transforming a message's frame into the fixed frame.
#[wasm_bindgen]
#[derive(Clone)]
pub struct TfResult {
    /// 0 = transformed at the message stamp, 1 = transformed with the latest
    /// transform (stamp outside history), 2 = not transformed (frame unknown /
    /// not connected): data is left in the message frame.
    pub status: u8,
}

fn transform_for(
    buf: &tf::TfBuffer,
    fixed_frame: &str,
    frame: &str,
    stamp_ns: u64,
) -> (Transform, u8) {
    match buf.lookup_with_fallback(fixed_frame, frame, stamp_ns) {
        Ok((t, false)) => (t, 0),
        Ok((t, true)) => (t, 1),
        Err(_) => (Transform::IDENTITY, 2),
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct OccupancyGridData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub resolution: f32,
    pub width: u32,
    pub height: u32,
    /// Origin pose of cell (0,0) in the message frame: x y z qx qy qz qw.
    pub origin: Vec<f64>,
    /// `width * height` bytes, row-major, int8 reinterpreted as u8 (-1 → 255).
    pub data: Vec<u8>,
}

#[wasm_bindgen(getter_with_clone)]
pub struct OccupancyGridUpdateData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Poses in the fixed frame: positions `xyz` × n, orientations `xyzw` × n.
#[wasm_bindgen(getter_with_clone)]
pub struct PosesData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub tf_status: u8,
    pub positions: Vec<f32>,
    pub orientations: Vec<f32>,
}

fn poses_data(
    buf: &tf::TfBuffer,
    fixed_frame: &str,
    header: &msgs::Header,
    poses: &[Transform],
) -> PosesData {
    let stamp_ns = header.stamp.to_ns();
    let (tf, tf_status) = transform_for(buf, fixed_frame, &header.frame_id, stamp_ns);
    let mut positions = Vec::with_capacity(poses.len() * 3);
    let mut orientations = Vec::with_capacity(poses.len() * 4);
    for p in poses {
        let t = tf.mul(p);
        positions.extend(t.t.iter().map(|v| *v as f32));
        orientations.extend(t.q.iter().map(|v| *v as f32));
    }
    PosesData {
        frame_id: header.frame_id.clone(),
        stamp_ns,
        tf_status,
        positions,
        orientations,
    }
}

#[wasm_bindgen]
impl TfBuffer {
    /// nav_msgs/OccupancyGrid. The origin stays in the message frame; the main
    /// thread looks the frame up every render so the map follows tf.
    #[wasm_bindgen(js_name = decodeOccupancyGrid)]
    pub fn decode_occupancy_grid(&self, bytes: &[u8]) -> Result<OccupancyGridData, JsError> {
        let g =
            msgs::nav::decode_occupancy_grid(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(OccupancyGridData {
            frame_id: g.header.frame_id,
            stamp_ns: g.header.stamp.to_ns(),
            resolution: g.resolution,
            width: g.width,
            height: g.height,
            origin: transform_to_vec(&g.origin),
            data: g.data,
        })
    }

    #[wasm_bindgen(js_name = decodeOccupancyGridUpdate)]
    pub fn decode_occupancy_grid_update(
        &self,
        bytes: &[u8],
    ) -> Result<OccupancyGridUpdateData, JsError> {
        let u = msgs::nav::decode_occupancy_grid_update(bytes)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(OccupancyGridUpdateData {
            frame_id: u.header.frame_id,
            stamp_ns: u.header.stamp.to_ns(),
            x: u.x,
            y: u.y,
            width: u.width,
            height: u.height,
            data: u.data,
        })
    }

    /// nav_msgs/Path → poses in the fixed frame.
    #[wasm_bindgen(js_name = decodePath)]
    pub fn decode_path(&self, bytes: &[u8], fixed_frame: &str) -> Result<PosesData, JsError> {
        let p = msgs::nav::decode_path(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(poses_data(&self.inner, fixed_frame, &p.header, &p.poses))
    }

    /// geometry_msgs/PoseStamped → one pose in the fixed frame.
    #[wasm_bindgen(js_name = decodePoseStamped)]
    pub fn decode_pose_stamped(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
    ) -> Result<PosesData, JsError> {
        let p =
            msgs::geometry::decode_pose_stamped(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(poses_data(&self.inner, fixed_frame, &p.header, &[p.pose]))
    }

    /// geometry_msgs/PoseArray → poses in the fixed frame.
    #[wasm_bindgen(js_name = decodePoseArray)]
    pub fn decode_pose_array(&self, bytes: &[u8], fixed_frame: &str) -> Result<PosesData, JsError> {
        let p =
            msgs::geometry::decode_pose_array(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(poses_data(&self.inner, fixed_frame, &p.header, &p.poses))
    }
}

// ---------------------------------------------------------------------------
// Point clouds (M5)
// ---------------------------------------------------------------------------

/// GPU-ready point cloud in the fixed frame.
#[wasm_bindgen(getter_with_clone)]
pub struct PointCloudData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub tf_status: u8,
    pub count: u32,
    /// xyz × count
    pub positions: Vec<f32>,
    /// rgb × count
    pub colors: Vec<u8>,
    /// JSON array of channel names available for the Intensity transformer.
    pub channels_json: String,
    /// JSON array of transformer names supported by this cloud.
    pub transformers_json: String,
    /// Transformer actually applied.
    pub transformer: String,
    pub min: f32,
    pub max: f32,
}

#[derive(serde::Deserialize)]
#[serde(default)]
struct ColorOptionsJson {
    transformer: String,
    flat_color: [u8; 3],
    axis: u8,
    axis_autocompute: bool,
    axis_min: f32,
    axis_max: f32,
    axis_use_fixed_frame: bool,
    channel: String,
    use_rainbow: bool,
    invert_rainbow: bool,
    min_color: [u8; 3],
    max_color: [u8; 3],
    intensity_autocompute: bool,
    min_intensity: f32,
    max_intensity: f32,
}

impl Default for ColorOptionsJson {
    fn default() -> Self {
        let d = ColorOptions::default();
        Self {
            transformer: d.transformer.name().into(),
            flat_color: d.flat_color,
            axis: d.axis,
            axis_autocompute: d.axis_autocompute,
            axis_min: d.axis_min,
            axis_max: d.axis_max,
            axis_use_fixed_frame: d.axis_use_fixed_frame,
            channel: d.channel,
            use_rainbow: d.use_rainbow,
            invert_rainbow: d.invert_rainbow,
            min_color: d.min_color,
            max_color: d.max_color,
            intensity_autocompute: d.intensity_autocompute,
            min_intensity: d.min_intensity,
            max_intensity: d.max_intensity,
        }
    }
}

fn parse_color_options(json: &str) -> ColorOptions {
    let j: ColorOptionsJson = serde_json::from_str(json).unwrap_or_default();
    ColorOptions {
        transformer: Transformer::from_name(&j.transformer).unwrap_or(Transformer::Intensity),
        flat_color: j.flat_color,
        axis: j.axis,
        axis_autocompute: j.axis_autocompute,
        axis_min: j.axis_min,
        axis_max: j.axis_max,
        axis_use_fixed_frame: j.axis_use_fixed_frame,
        channel: j.channel,
        use_rainbow: j.use_rainbow,
        invert_rainbow: j.invert_rainbow,
        min_color: j.min_color,
        max_color: j.max_color,
        intensity_autocompute: j.intensity_autocompute,
        min_intensity: j.min_intensity,
        max_intensity: j.max_intensity,
    }
}

fn cloud_data(
    buf: &tf::TfBuffer,
    fixed_frame: &str,
    header: &msgs::Header,
    pts: &pointcloud::Points,
    opts: &ColorOptions,
) -> PointCloudData {
    let stamp_ns = header.stamp.to_ns();
    let (tf, tf_status) = transform_for(buf, fixed_frame, &header.frame_id, stamp_ns);
    let out = pointcloud::build_cloud(pts, &tf, opts);
    let channels: Vec<&str> = pts.channels.iter().map(|(n, _)| n.as_str()).collect();
    let transformers: Vec<&str> = pts
        .available_transformers()
        .iter()
        .map(|t| t.name())
        .collect();
    PointCloudData {
        frame_id: header.frame_id.clone(),
        stamp_ns,
        tf_status,
        count: out.count as u32,
        positions: out.positions,
        colors: out.colors,
        channels_json: serde_json::to_string(&channels).unwrap_or_default(),
        transformers_json: serde_json::to_string(&transformers).unwrap_or_default(),
        transformer: out.transformer.name().into(),
        min: out.min,
        max: out.max,
    }
}

#[wasm_bindgen]
impl TfBuffer {
    /// sensor_msgs/PointCloud2 → positions in the fixed frame + colours. `options_json` holds the
    /// colour transformer settings (see `ColorOptions`).
    #[wasm_bindgen(js_name = decodePointCloud2)]
    pub fn decode_point_cloud2(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
        options_json: &str,
    ) -> Result<PointCloudData, JsError> {
        let cloud = msgs::pointcloud::decode_point_cloud2(bytes)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let pts = pointcloud::points_from_cloud2(&cloud).map_err(JsError::new)?;
        Ok(cloud_data(
            &self.inner,
            fixed_frame,
            &cloud.header,
            &pts,
            &parse_color_options(options_json),
        ))
    }

    /// sensor_msgs/LaserScan → projected points with an intensity channel.
    #[wasm_bindgen(js_name = decodeLaserScan)]
    pub fn decode_laser_scan(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
        options_json: &str,
    ) -> Result<PointCloudData, JsError> {
        let scan =
            msgs::pointcloud::decode_laser_scan(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        let pts = pointcloud::points_from_laser_scan(&scan);
        Ok(cloud_data(
            &self.inner,
            fixed_frame,
            &scan.header,
            &pts,
            &parse_color_options(options_json),
        ))
    }
}

// ---------------------------------------------------------------------------
// Markers (M6)
// ---------------------------------------------------------------------------

/// Values per marker in [`MarkerArrayData::numeric`].
pub const MARKER_STRIDE: usize = 24;

/// Flat representation of a MarkerArray (or a single Marker):
/// `numeric` holds MARKER_STRIDE f64 per marker:
/// `id, type, action, px, py, pz, qx, qy, qz, qw, sx, sy, sz, r, g, b, a,
///  lifetime_s, frame_locked, tf_status, points_offset, points_len, colors_offset, colors_len`
/// (pose in the fixed frame unless `frame_locked`, in which case it stays in
/// the marker frame and the main thread follows tf). `strings_json` is an
/// array of `[ns, frame_id, text, mesh_resource, error]` per marker.
#[wasm_bindgen(getter_with_clone)]
pub struct MarkerArrayData {
    pub count: u32,
    pub numeric: Vec<f64>,
    pub strings_json: String,
    pub points: Vec<f32>,
    pub colors: Vec<u8>,
}

fn pack_markers(
    buf: &tf::TfBuffer,
    fixed_frame: &str,
    markers: &[msgs::marker::Marker],
) -> MarkerArrayData {
    let mut numeric = Vec::with_capacity(markers.len() * MARKER_STRIDE);
    let mut strings: Vec<[&str; 5]> = Vec::with_capacity(markers.len());
    let mut points: Vec<f32> = Vec::new();
    let mut colors: Vec<u8> = Vec::new();
    let mut errors: Vec<String> = Vec::with_capacity(markers.len());
    for m in markers {
        errors.push(msgs::marker::validate(m).err().unwrap_or_default());
    }
    for (m, err) in markers.iter().zip(errors.iter()) {
        let stamp_ns = m.header.stamp.to_ns();
        let (pose, tf_status) = if m.frame_locked {
            (m.pose, 0u8)
        } else {
            let (t, s) = transform_for(buf, fixed_frame, &m.header.frame_id, stamp_ns);
            (t.mul(&m.pose), s)
        };
        let po = points.len();
        points.extend_from_slice(&m.points);
        let co = colors.len();
        colors.extend_from_slice(&m.colors);
        numeric.extend_from_slice(&[
            m.id as f64,
            m.kind as f64,
            m.action as f64,
            pose.t[0],
            pose.t[1],
            pose.t[2],
            pose.q[0],
            pose.q[1],
            pose.q[2],
            pose.q[3],
            m.scale[0],
            m.scale[1],
            m.scale[2],
            m.color[0] as f64,
            m.color[1] as f64,
            m.color[2] as f64,
            m.color[3] as f64,
            m.lifetime_ns as f64 / 1e9,
            if m.frame_locked { 1.0 } else { 0.0 },
            tf_status as f64,
            po as f64,
            m.points.len() as f64,
            co as f64,
            m.colors.len() as f64,
        ]);
        strings.push([
            &m.ns,
            &m.header.frame_id,
            &m.text,
            &m.mesh_resource,
            err.as_str(),
        ]);
    }
    MarkerArrayData {
        count: markers.len() as u32,
        numeric,
        strings_json: serde_json::to_string(&strings).unwrap_or_else(|_| "[]".into()),
        points,
        colors,
    }
}

#[wasm_bindgen]
impl TfBuffer {
    #[wasm_bindgen(js_name = decodeMarker)]
    pub fn decode_marker(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
    ) -> Result<MarkerArrayData, JsError> {
        let m = msgs::marker::decode_marker(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(pack_markers(
            &self.inner,
            fixed_frame,
            core::slice::from_ref(&m),
        ))
    }

    #[wasm_bindgen(js_name = decodeMarkerArray)]
    pub fn decode_marker_array(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
    ) -> Result<MarkerArrayData, JsError> {
        let v =
            msgs::marker::decode_marker_array(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(pack_markers(&self.inner, fixed_frame, &v))
    }
}
