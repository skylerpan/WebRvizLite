//! visualization_msgs/Marker and MarkerArray (Humble layout, which includes
//! the texture / mesh_file fields; older distros without them would decode
//! the trailing fields wrongly, so the decoder stops gracefully at end of data).

use super::common::{Header, read_vec3};
use super::geometry::read_pose;
use crate::cdr::{CdrError, Reader};
use crate::math::Transform;
#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

pub const ARROW: i32 = 0;
pub const CUBE: i32 = 1;
pub const SPHERE: i32 = 2;
pub const CYLINDER: i32 = 3;
pub const LINE_STRIP: i32 = 4;
pub const LINE_LIST: i32 = 5;
pub const CUBE_LIST: i32 = 6;
pub const SPHERE_LIST: i32 = 7;
pub const POINTS: i32 = 8;
pub const TEXT_VIEW_FACING: i32 = 9;
pub const MESH_RESOURCE: i32 = 10;
pub const TRIANGLE_LIST: i32 = 11;

pub const ADD: i32 = 0;
pub const MODIFY: i32 = 0;
pub const DELETE: i32 = 2;
pub const DELETEALL: i32 = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct Marker {
    pub header: Header,
    pub ns: String,
    pub id: i32,
    pub kind: i32,
    pub action: i32,
    pub pose: Transform,
    pub scale: [f64; 3],
    pub color: [f32; 4],
    pub lifetime_ns: i64,
    pub frame_locked: bool,
    /// xyz × n, marker-local
    pub points: Vec<f32>,
    /// rgba × n (0–255), empty when the marker has no per-vertex colours
    pub colors: Vec<u8>,
    pub text: String,
    pub mesh_resource: String,
    pub mesh_use_embedded_materials: bool,
}

fn read_color_rgba(r: &mut Reader) -> Result<[f32; 4], CdrError> {
    Ok([r.f32()?, r.f32()?, r.f32()?, r.f32()?])
}

fn read_marker(r: &mut Reader) -> Result<Marker, CdrError> {
    let header = Header::read(r)?;
    let ns = r.string()?;
    let id = r.i32()?;
    let kind = r.i32()?;
    let action = r.i32()?;
    let pose = read_pose(r)?;
    let scale = read_vec3(r)?;
    let color = read_color_rgba(r)?;
    let lifetime_ns = r.i32()? as i64 * 1_000_000_000 + r.u32()? as i64;
    let frame_locked = r.bool()?;
    let n_points = r.seq_len(24)?;
    let mut points = Vec::with_capacity(n_points * 3);
    for _ in 0..n_points {
        let p = read_vec3(r)?;
        points.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
    }
    let n_colors = r.seq_len(16)?;
    let mut colors = Vec::with_capacity(n_colors * 4);
    for _ in 0..n_colors {
        let c = read_color_rgba(r)?;
        colors.extend(c.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0) as u8));
    }
    let mut m = Marker {
        header,
        ns,
        id,
        kind,
        action,
        pose,
        scale,
        color,
        lifetime_ns,
        frame_locked,
        points,
        colors,
        text: String::new(),
        mesh_resource: String::new(),
        mesh_use_embedded_materials: false,
    };
    // Trailing fields (Humble+). Stop quietly if the message ends early.
    if r.remaining() == 0 {
        return Ok(m);
    }
    let _texture_resource = r.string()?;
    // texture: sensor_msgs/CompressedImage { header, format, data }
    let _ = Header::read(r)?;
    let _format = r.string()?;
    let n = r.seq_len(1)?;
    r.bytes(n)?;
    // uv_coordinates: UVCoordinate[] { float32 u, v }
    let n_uv = r.seq_len(8)?;
    for _ in 0..n_uv {
        r.f32()?;
        r.f32()?;
    }
    m.text = r.string()?;
    m.mesh_resource = r.string()?;
    // mesh_file: MeshFile { string filename, uint8[] data }
    let _filename = r.string()?;
    let n = r.seq_len(1)?;
    r.bytes(n)?;
    m.mesh_use_embedded_materials = r.bool()?;
    Ok(m)
}

pub fn decode_marker(bytes: &[u8]) -> Result<Marker, CdrError> {
    let mut r = Reader::new(bytes)?;
    read_marker(&mut r)
}

pub fn decode_marker_array(bytes: &[u8]) -> Result<Vec<Marker>, CdrError> {
    let mut r = Reader::new(bytes)?;
    let n = r.seq_len(100)?; // a marker is well over 100 bytes
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(read_marker(&mut r)?);
    }
    Ok(out)
}

/// Checks the rviz validity rules: finite pose/scale/points, and positive
/// scale where the type uses it. Returns an error message for the Status row.
pub fn validate(m: &Marker) -> Result<(), String> {
    if m.action != ADD {
        return Ok(());
    }
    if !m.pose.is_finite() {
        return Err(String::from("Marker pose contains NaN or Inf values"));
    }
    if !m.scale.iter().all(|v| v.is_finite()) {
        return Err(String::from("Marker scale contains NaN or Inf values"));
    }
    if !m.color.iter().all(|v| v.is_finite()) {
        return Err(String::from("Marker color contains NaN or Inf values"));
    }
    if m.points.iter().any(|v| !v.is_finite()) {
        return Err(String::from("Marker points contain NaN or Inf values"));
    }
    let needs_scale = matches!(
        m.kind,
        CUBE | SPHERE | CYLINDER | CUBE_LIST | SPHERE_LIST | MESH_RESOURCE
    );
    if needs_scale && (m.scale[0] <= 0.0 || m.scale[1] <= 0.0 || m.scale[2] <= 0.0) {
        return Err(String::from(
            "Marker scale must be positive for shape markers",
        ));
    }
    if matches!(m.kind, LINE_STRIP | LINE_LIST | POINTS) && m.scale[0] <= 0.0 {
        return Err(String::from(
            "Marker scale.x must be positive for line/point markers",
        ));
    }
    if m.kind == TEXT_VIEW_FACING && m.scale[2] <= 0.0 {
        return Err(String::from(
            "Marker scale.z (text height) must be positive",
        ));
    }
    if m.kind == ARROW && !m.points.is_empty() && m.points.len() != 6 {
        return Err(String::from("Arrow marker needs 0 or 2 points"));
    }
    if m.kind == LINE_LIST && !m.points.len().is_multiple_of(6) {
        return Err(String::from(
            "Line list marker needs an even number of points",
        ));
    }
    if m.kind == TRIANGLE_LIST && !m.points.len().is_multiple_of(9) {
        return Err(String::from(
            "Triangle list marker needs a multiple of 3 points",
        ));
    }
    if !m.colors.is_empty() && m.colors.len() / 4 != m.points.len() / 3 {
        return Err(String::from(
            "Marker colors count does not match points count",
        ));
    }
    if m.kind < ARROW || m.kind > TRIANGLE_LIST {
        return Err(String::from("Unknown marker type"));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cdr::Writer;

    /// Writes a Humble-layout Marker.
    pub fn write_marker(
        w: &mut Writer,
        ns: &str,
        id: i32,
        kind: i32,
        action: i32,
        points: &[[f32; 3]],
        text: &str,
    ) {
        w.i32(1).u32(2).string("map");
        w.string(ns).i32(id).i32(kind).i32(action);
        for v in [1.0f64, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0] {
            w.f64(v);
        }
        for v in [0.5f64, 0.5, 0.5] {
            w.f64(v);
        }
        for v in [1.0f32, 0.5, 0.25, 1.0] {
            w.f32(v);
        }
        w.i32(3).u32(0); // lifetime
        w.bool(false);
        w.seq_len(points.len());
        for p in points {
            for v in p {
                w.f64(*v as f64);
            }
        }
        w.seq_len(0); // colors
        w.string(""); // texture_resource
        w.i32(0).u32(0).string(""); // texture header
        w.string(""); // texture format
        w.seq_len(0); // texture data
        w.seq_len(0); // uv_coordinates
        w.string(text);
        w.string("package://foo/mesh.dae");
        w.string(""); // mesh_file.filename
        w.seq_len(0); // mesh_file.data
        w.bool(true);
    }

    #[test]
    fn marker_and_array_decode() {
        let mut w = Writer::new();
        write_marker(&mut w, "ns", 7, CUBE, ADD, &[], "hello");
        let m = decode_marker(&w.finish()).unwrap();
        assert_eq!((m.ns.as_str(), m.id, m.kind), ("ns", 7, CUBE));
        assert_eq!(m.pose.t, [1.0, 2.0, 3.0]);
        assert_eq!(m.scale, [0.5, 0.5, 0.5]);
        assert_eq!(m.lifetime_ns, 3_000_000_000);
        assert_eq!(m.text, "hello");
        assert_eq!(m.mesh_resource, "package://foo/mesh.dae");
        assert!(m.mesh_use_embedded_materials);
        assert!(validate(&m).is_ok());

        let mut w = Writer::new();
        w.seq_len(2);
        write_marker(&mut w, "a", 1, SPHERE, ADD, &[], "");
        write_marker(
            &mut w,
            "b",
            2,
            LINE_LIST,
            ADD,
            &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
            "",
        );
        let v = decode_marker_array(&w.finish()).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].points.len(), 6);
    }

    #[test]
    fn validation_rules() {
        let mut w = Writer::new();
        write_marker(&mut w, "a", 1, LINE_LIST, ADD, &[[0.0; 3]], "");
        let m = decode_marker(&w.finish()).unwrap();
        assert!(validate(&m).unwrap_err().contains("even number"));
        let mut m2 = m.clone();
        m2.kind = CUBE;
        m2.scale = [0.0, 1.0, 1.0];
        assert!(validate(&m2).unwrap_err().contains("positive"));
        m2.scale = [f64::NAN, 1.0, 1.0];
        assert!(validate(&m2).unwrap_err().contains("NaN"));
        m2.action = DELETE;
        assert!(validate(&m2).is_ok());
    }
}
