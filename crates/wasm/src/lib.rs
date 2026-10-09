//! JS-facing API used by the Web Worker. Keep this layer thin: all logic lives
//! in `webrvizlite-core` so it can be unit-tested natively.

// wasm-bindgen's getter_with_clone generates `.clone()` on Copy fields too.
// Array fields are private and moved out with `take_*` (one copy into JS,
// no Rust-side clone); the JS side frees the object afterwards.
#![allow(clippy::clone_on_copy)]

use wasm_bindgen::prelude::*;
use webrvizlite_core::covariance;
use webrvizlite_core::image;
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

/// Channel values of one point of a raw cloud message, for the Selection panel.
/// `kind` is the worker decoder name; returns `{"names": [...], "values": [...]}`.
#[wasm_bindgen(js_name = pointInfoJson)]
pub fn point_info_json(bytes: &[u8], kind: &str, index: u32) -> Result<String, JsError> {
    let pts = match kind {
        "point_cloud2" => {
            let cloud = msgs::pointcloud::decode_point_cloud2(bytes)
                .map_err(|e| JsError::new(&e.to_string()))?;
            pointcloud::points_from_cloud2(&cloud).map_err(JsError::new)?
        }
        "laser_scan" => pointcloud::points_from_laser_scan(
            &msgs::pointcloud::decode_laser_scan(bytes)
                .map_err(|e| JsError::new(&e.to_string()))?,
        ),
        "livox_custom_msg" => pointcloud::points_from_livox(
            &msgs::pointcloud::decode_livox_custom_msg(bytes)
                .map_err(|e| JsError::new(&e.to_string()))?,
        ),
        other => return Err(JsError::new(&format!("not a point cloud decoder: {other}"))),
    };
    let i = index as usize;
    if i >= pts.len() {
        return Err(JsError::new("point index out of range"));
    }
    let mut names: Vec<&str> = vec!["x", "y", "z"];
    let mut values: Vec<f64> = vec![
        pts.xyz[i * 3] as f64,
        pts.xyz[i * 3 + 1] as f64,
        pts.xyz[i * 3 + 2] as f64,
    ];
    for (name, data) in &pts.channels {
        names.push(name);
        values.push(data.get(i).copied().unwrap_or(f32::NAN) as f64);
    }
    if let Some(rgb) = &pts.rgb {
        names.push("rgb");
        values.push(rgb.get(i).copied().unwrap_or(0) as f64);
    }
    let values: Vec<serde_json::Value> = values
        .into_iter()
        .map(|v| {
            serde_json::Number::from_f64(v)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null)
        })
        .collect();
    serde_json::to_string(&serde_json::json!({ "names": names, "values": values }))
        .map_err(|e| JsError::new(&e.to_string()))
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
    origin: Vec<f64>,
    /// `width * height` bytes, row-major, int8 reinterpreted as u8 (-1 → 255).
    data: Vec<u8>,
}

#[wasm_bindgen]
impl OccupancyGridData {
    /// Moves `origin` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeOrigin)]
    pub fn take_origin(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.origin)
    }
    /// Moves `data` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeData)]
    pub fn take_data(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.data)
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct OccupancyGridUpdateData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl OccupancyGridUpdateData {
    /// Moves `data` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeData)]
    pub fn take_data(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.data)
    }
}

/// Poses in the fixed frame: positions `xyz` × n, orientations `xyzw` × n.
#[wasm_bindgen(getter_with_clone)]
pub struct PosesData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub tf_status: u8,
    positions: Vec<f32>,
    orientations: Vec<f32>,
}

#[wasm_bindgen]
impl PosesData {
    /// Moves `positions` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takePositions)]
    pub fn take_positions(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.positions)
    }
    /// Moves `orientations` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeOrientations)]
    pub fn take_orientations(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.orientations)
    }
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

/// Pose with covariance in the fixed frame, plus the ready-to-draw covariance
/// visual (rviz CovarianceVisual): `ellipsoid` = [sx, sy, sz, qx, qy, qz, qw]
/// (half axes already scaled, orientation composed with the fixed-frame
/// rotation; empty when the position covariance is zero / invalid) and
/// `orientation` = 3 × [axis, a, b, angle] discs (3-D) or [half_angle] (2-D).
#[wasm_bindgen(getter_with_clone)]
pub struct PoseCovData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub tf_status: u8,
    pub child_frame_id: String,
    positions: Vec<f32>,
    orientations: Vec<f32>,
    covariance: Vec<f64>,
    ellipsoid: Vec<f32>,
    orientation: Vec<f32>,
    pub is_2d: bool,
}

#[wasm_bindgen]
impl PoseCovData {
    /// Moves `positions` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takePositions)]
    pub fn take_positions(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.positions)
    }
    /// Moves `orientations` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeOrientations)]
    pub fn take_orientations(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.orientations)
    }
    /// Moves `covariance` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeCovariance)]
    pub fn take_covariance(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.covariance)
    }
    /// Moves `ellipsoid` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeEllipsoid)]
    pub fn take_ellipsoid(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.ellipsoid)
    }
    /// Moves `orientation` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeOrientation)]
    pub fn take_orientation(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.orientation)
    }
}

/// Points (xyz × n) in the fixed frame.
#[wasm_bindgen(getter_with_clone)]
pub struct PointsData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub tf_status: u8,
    positions: Vec<f32>,
}

#[wasm_bindgen]
impl PointsData {
    /// Moves `positions` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takePositions)]
    pub fn take_positions(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.positions)
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct GridCellsData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub tf_status: u8,
    positions: Vec<f32>,
    pub cell_width: f32,
    pub cell_height: f32,
}

#[wasm_bindgen]
impl GridCellsData {
    /// Moves `positions` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takePositions)]
    pub fn take_positions(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.positions)
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct RangeData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub tf_status: u8,
    /// Sensor pose in the fixed frame: xyz + xyzw.
    positions: Vec<f32>,
    orientations: Vec<f32>,
    pub range: f32,
    pub field_of_view: f32,
    pub min_range: f32,
    pub max_range: f32,
}

#[wasm_bindgen]
impl RangeData {
    /// Moves `positions` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takePositions)]
    pub fn take_positions(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.positions)
    }
    /// Moves `orientations` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeOrientations)]
    pub fn take_orientations(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.orientations)
    }
}

#[derive(serde::Deserialize)]
struct CovarianceOptions {
    #[serde(default = "one")]
    pos_scale: f64,
    #[serde(default = "one")]
    ori_scale: f64,
    #[serde(default = "one")]
    ori_offset: f64,
}
fn one() -> f64 {
    1.0
}

fn pose_cov_data(
    buf: &tf::TfBuffer,
    fixed_frame: &str,
    header: &msgs::Header,
    child_frame_id: &str,
    pose: &Transform,
    cov: &[f64; 36],
    options_json: &str,
) -> PoseCovData {
    let opts: CovarianceOptions = serde_json::from_str(options_json).unwrap_or(CovarianceOptions {
        pos_scale: 1.0,
        ori_scale: 1.0,
        ori_offset: 1.0,
    });
    let stamp_ns = header.stamp.to_ns();
    let (tf, tf_status) = transform_for(buf, fixed_frame, &header.frame_id, stamp_ns);
    let t = tf.mul(pose);
    let ellipsoid = covariance::position_ellipsoid(cov, opts.pos_scale)
        .map(|e| {
            let q = webrvizlite_core::math::quat_mul(tf.q, e.quat);
            vec![
                e.half_axes[0] as f32,
                e.half_axes[1] as f32,
                e.half_axes[2] as f32,
                q[0] as f32,
                q[1] as f32,
                q[2] as f32,
                q[3] as f32,
            ]
        })
        .unwrap_or_default();
    let orientation = covariance::orientation_visual(cov, opts.ori_scale, opts.ori_offset)
        .map(|v| covariance::orientation_to_vec(&v))
        .unwrap_or_default();
    PoseCovData {
        frame_id: header.frame_id.clone(),
        stamp_ns,
        tf_status,
        child_frame_id: child_frame_id.into(),
        positions: t.t.iter().map(|v| *v as f32).collect(),
        orientations: t.q.iter().map(|v| *v as f32).collect(),
        covariance: cov.to_vec(),
        ellipsoid,
        orientation,
        is_2d: covariance::is_2d(cov),
    }
}

fn points_in_fixed_frame(tf: &Transform, xyz: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(xyz.len());
    for p in xyz.as_chunks::<3>().0 {
        let q = tf.apply_point([p[0] as f64, p[1] as f64, p[2] as f64]);
        out.extend(q.iter().map(|v| *v as f32));
    }
    out
}

/// RGBA8 conversion of one sensor_msgs/Image for an Image / Camera display.
#[wasm_bindgen(getter_with_clone)]
pub struct ImageData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub width: u32,
    pub height: u32,
    pub encoding: String,
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl ImageData {
    /// Moves `rgba` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeRgba)]
    pub fn take_rgba(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgba)
    }
}

/// Per-subscription image converter (keeps the depth normalisation history).
#[wasm_bindgen]
#[derive(Default)]
pub struct ImageConverter {
    state: image::ImageNormalizer,
}

#[derive(serde::Deserialize)]
struct ImageOptionsJson {
    #[serde(default = "default_true")]
    normalize: bool,
    #[serde(default)]
    min: f32,
    #[serde(default = "one_f32")]
    max: f32,
    #[serde(default = "five")]
    median_window: usize,
}
fn default_true() -> bool {
    true
}
fn one_f32() -> f32 {
    1.0
}
fn five() -> usize {
    5
}

#[wasm_bindgen]
impl ImageConverter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ImageConverter {
        ImageConverter::default()
    }

    /// `options_json`: `{normalize, min, max, median_window}` (Image display properties).
    pub fn convert(&mut self, bytes: &[u8], options_json: &str) -> Result<ImageData, JsError> {
        let img = msgs::sensor::decode_image(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        let o: ImageOptionsJson = serde_json::from_str(options_json).unwrap_or(ImageOptionsJson {
            normalize: true,
            min: 0.0,
            max: 1.0,
            median_window: 5,
        });
        let opts = image::DepthOptions {
            normalize: o.normalize,
            min: o.min,
            max: o.max,
            median_window: o.median_window,
        };
        let mut rgba = Vec::new();
        image::to_rgba8(&img, &opts, &mut self.state, &mut rgba).map_err(|e| JsError::new(&e))?;
        Ok(ImageData {
            frame_id: img.header.frame_id,
            stamp_ns: img.header.stamp.to_ns(),
            width: img.width,
            height: img.height,
            encoding: img.encoding,
            rgba,
        })
    }
}

/// Camera intrinsics for the Camera display.
#[wasm_bindgen(getter_with_clone)]
pub struct CameraInfoData {
    pub frame_id: String,
    pub stamp_ns: u64,
    pub width: u32,
    pub height: u32,
    k: Vec<f64>,
    p: Vec<f64>,
    d: Vec<f64>,
    pub binning_x: u32,
    pub binning_y: u32,
    /// x_offset, y_offset, height, width
    roi: Vec<u32>,
}

#[wasm_bindgen]
impl CameraInfoData {
    /// Moves `k` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeK)]
    pub fn take_k(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.k)
    }
    /// Moves `p` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeP)]
    pub fn take_p(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.p)
    }
    /// Moves `d` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeD)]
    pub fn take_d(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.d)
    }
    /// Moves `roi` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeRoi)]
    pub fn take_roi(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.roi)
    }
}

#[wasm_bindgen(js_name = decodeCameraInfo)]
pub fn decode_camera_info(bytes: &[u8]) -> Result<CameraInfoData, JsError> {
    let c = msgs::sensor::decode_camera_info(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(CameraInfoData {
        frame_id: c.header.frame_id,
        stamp_ns: c.header.stamp.to_ns(),
        width: c.width,
        height: c.height,
        k: c.k.to_vec(),
        p: c.p.to_vec(),
        d: c.d,
        binning_x: c.binning_x,
        binning_y: c.binning_y,
        roi: c.roi.to_vec(),
    })
}

/// std_msgs/String payload (robot_description).
#[wasm_bindgen(js_name = decodeString)]
pub fn decode_string(bytes: &[u8]) -> Result<String, JsError> {
    msgs::std_msgs::decode_string(bytes).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
impl TfBuffer {
    /// nav_msgs/OccupancyGrid.
    /// geometry_msgs/PoseWithCovarianceStamped → pose + covariance visual in the fixed frame.
    #[wasm_bindgen(js_name = decodePoseWithCovariance)]
    pub fn decode_pose_with_covariance(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
        options_json: &str,
    ) -> Result<PoseCovData, JsError> {
        let p = msgs::geometry::decode_pose_with_covariance_stamped(bytes)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(pose_cov_data(
            &self.inner,
            fixed_frame,
            &p.header,
            "",
            &p.pose,
            &p.covariance,
            options_json,
        ))
    }

    /// nav_msgs/Odometry → pose + covariance visual in the fixed frame.
    #[wasm_bindgen(js_name = decodeOdometry)]
    pub fn decode_odometry(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
        options_json: &str,
    ) -> Result<PoseCovData, JsError> {
        let o = msgs::nav::decode_odometry(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(pose_cov_data(
            &self.inner,
            fixed_frame,
            &o.header,
            &o.child_frame_id,
            &o.pose,
            &o.pose_covariance,
            options_json,
        ))
    }

    /// geometry_msgs/PointStamped → one pose (identity orientation) in the fixed frame.
    #[wasm_bindgen(js_name = decodePointStamped)]
    pub fn decode_point_stamped(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
    ) -> Result<PosesData, JsError> {
        let p = msgs::geometry::decode_point_stamped(bytes)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let pose = Transform::new(p.point, [0.0, 0.0, 0.0, 1.0]);
        Ok(poses_data(&self.inner, fixed_frame, &p.header, &[pose]))
    }

    /// geometry_msgs/PolygonStamped → vertices in the fixed frame.
    #[wasm_bindgen(js_name = decodePolygonStamped)]
    pub fn decode_polygon_stamped(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
    ) -> Result<PointsData, JsError> {
        let p = msgs::geometry::decode_polygon_stamped(bytes)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let stamp_ns = p.header.stamp.to_ns();
        let (tf, tf_status) = transform_for(&self.inner, fixed_frame, &p.header.frame_id, stamp_ns);
        Ok(PointsData {
            frame_id: p.header.frame_id,
            stamp_ns,
            tf_status,
            positions: points_in_fixed_frame(&tf, &p.points),
        })
    }

    /// nav_msgs/GridCells → cell centres in the fixed frame.
    #[wasm_bindgen(js_name = decodeGridCells)]
    pub fn decode_grid_cells(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
    ) -> Result<GridCellsData, JsError> {
        let g = msgs::nav::decode_grid_cells(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        let stamp_ns = g.header.stamp.to_ns();
        let (tf, tf_status) = transform_for(&self.inner, fixed_frame, &g.header.frame_id, stamp_ns);
        Ok(GridCellsData {
            frame_id: g.header.frame_id,
            stamp_ns,
            tf_status,
            positions: points_in_fixed_frame(&tf, &g.cells),
            cell_width: g.cell_width,
            cell_height: g.cell_height,
        })
    }

    /// sensor_msgs/Range → sensor pose in the fixed frame + the cone parameters.
    #[wasm_bindgen(js_name = decodeRange)]
    pub fn decode_range(&self, bytes: &[u8], fixed_frame: &str) -> Result<RangeData, JsError> {
        let r = msgs::sensor::decode_range(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        let stamp_ns = r.header.stamp.to_ns();
        let (tf, tf_status) = transform_for(&self.inner, fixed_frame, &r.header.frame_id, stamp_ns);
        Ok(RangeData {
            frame_id: r.header.frame_id,
            stamp_ns,
            tf_status,
            positions: tf.t.iter().map(|v| *v as f32).collect(),
            orientations: tf.q.iter().map(|v| *v as f32).collect(),
            range: r.range,
            field_of_view: r.field_of_view,
            min_range: r.min_range,
            max_range: r.max_range,
        })
    }

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
    positions: Vec<f32>,
    /// rgb × count
    colors: Vec<u8>,
    /// JSON array of channel names available for the Intensity transformer.
    pub channels_json: String,
    /// JSON array of transformer names supported by this cloud.
    pub transformers_json: String,
    /// Transformer actually applied.
    pub transformer: String,
    pub min: f32,
    pub max: f32,
}

#[wasm_bindgen]
impl PointCloudData {
    /// Moves `positions` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takePositions)]
    pub fn take_positions(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.positions)
    }
    /// Moves `colors` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeColors)]
    pub fn take_colors(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.colors)
    }
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

    /// livox_ros_driver2/CustomMsg → points with intensity (reflectivity), tag, line and
    /// offset_time channels.
    #[wasm_bindgen(js_name = decodeLivoxCustomMsg)]
    pub fn decode_livox_custom_msg(
        &self,
        bytes: &[u8],
        fixed_frame: &str,
        options_json: &str,
    ) -> Result<PointCloudData, JsError> {
        let msg = msgs::pointcloud::decode_livox_custom_msg(bytes)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let pts = pointcloud::points_from_livox(&msg);
        Ok(cloud_data(
            &self.inner,
            fixed_frame,
            &msg.header,
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
    numeric: Vec<f64>,
    pub strings_json: String,
    points: Vec<f32>,
    colors: Vec<u8>,
}

#[wasm_bindgen]
impl MarkerArrayData {
    /// Moves `numeric` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeNumeric)]
    pub fn take_numeric(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.numeric)
    }
    /// Moves `points` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takePoints)]
    pub fn take_points(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.points)
    }
    /// Moves `colors` out (one copy into JS); the object must then be freed.
    #[wasm_bindgen(js_name = takeColors)]
    pub fn take_colors(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.colors)
    }
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
