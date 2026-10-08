//! sensor_msgs/PointCloud2, sensor_msgs/LaserScan and livox_ros_driver2/CustomMsg
//! → a flat point set (`Points`) that the colour transformers in
//! [`crate::pointcloud`] consume.

use super::common::Header;
use crate::cdr::{CdrError, Reader};
#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

pub const INT8: u8 = 1;
pub const UINT8: u8 = 2;
pub const INT16: u8 = 3;
pub const UINT16: u8 = 4;
pub const INT32: u8 = 5;
pub const UINT32: u8 = 6;
pub const FLOAT32: u8 = 7;
pub const FLOAT64: u8 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointField {
    pub name: String,
    pub offset: u32,
    pub datatype: u8,
    pub count: u32,
}

/// Borrowed view of a PointCloud2 message.
#[derive(Debug, Clone, PartialEq)]
pub struct PointCloud2<'a> {
    pub header: Header,
    pub height: u32,
    pub width: u32,
    pub fields: Vec<PointField>,
    pub is_bigendian: bool,
    pub point_step: u32,
    pub row_step: u32,
    pub data: &'a [u8],
    pub is_dense: bool,
}

pub fn decode_point_cloud2(bytes: &[u8]) -> Result<PointCloud2<'_>, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let height = r.u32()?;
    let width = r.u32()?;
    let n_fields = r.seq_len(4 + 4 + 1 + 4)?;
    let mut fields = Vec::with_capacity(n_fields);
    for _ in 0..n_fields {
        let name = r.string()?;
        let offset = r.u32()?;
        let datatype = r.u8()?;
        let count = r.u32()?;
        fields.push(PointField {
            name,
            offset,
            datatype,
            count,
        });
    }
    let is_bigendian = r.bool()?;
    let point_step = r.u32()?;
    let row_step = r.u32()?;
    let n = r.seq_len(1)?;
    let data = r.bytes(n)?;
    let is_dense = r.bool()?;
    Ok(PointCloud2 {
        header,
        height,
        width,
        fields,
        is_bigendian,
        point_step,
        row_step,
        data,
        is_dense,
    })
}

impl PointCloud2<'_> {
    pub fn point_count(&self) -> usize {
        let n = self.width as usize * self.height as usize;
        if self.point_step == 0 {
            return 0;
        }
        n.min(self.data.len() / self.point_step as usize)
    }

    pub fn field(&self, name: &str) -> Option<&PointField> {
        self.fields.iter().find(|f| f.name == name)
    }

    /// Reads one scalar of `field` for point `i` as f32 (any numeric datatype).
    #[inline]
    pub fn read_f32(&self, field: &PointField, i: usize) -> f32 {
        let o = i * self.point_step as usize + field.offset as usize;
        let d = self.data;
        let be = self.is_bigendian;
        macro_rules! rd {
            ($t:ty, $n:expr) => {{
                if o + $n > d.len() {
                    return f32::NAN;
                }
                let mut b = [0u8; $n];
                b.copy_from_slice(&d[o..o + $n]);
                if be {
                    <$t>::from_be_bytes(b)
                } else {
                    <$t>::from_le_bytes(b)
                }
            }};
        }
        match field.datatype {
            INT8 => rd!(i8, 1) as f32,
            UINT8 => rd!(u8, 1) as f32,
            INT16 => rd!(i16, 2) as f32,
            UINT16 => rd!(u16, 2) as f32,
            INT32 => rd!(i32, 4) as f32,
            UINT32 => rd!(u32, 4) as f32,
            FLOAT32 => rd!(f32, 4),
            FLOAT64 => rd!(f64, 8) as f32,
            _ => f32::NAN,
        }
    }

    /// Reads the raw 32 bits of `field` for point `i` (packed RGB / RGBA).
    #[inline]
    pub fn read_u32_bits(&self, field: &PointField, i: usize) -> u32 {
        let o = i * self.point_step as usize + field.offset as usize;
        if o + 4 > self.data.len() {
            return 0;
        }
        let b = [
            self.data[o],
            self.data[o + 1],
            self.data[o + 2],
            self.data[o + 3],
        ];
        if self.is_bigendian {
            u32::from_be_bytes(b)
        } else {
            u32::from_le_bytes(b)
        }
    }
}

/// sensor_msgs/msg/LaserScan
#[derive(Debug, Clone, PartialEq)]
pub struct LaserScan {
    pub header: Header,
    pub angle_min: f32,
    pub angle_max: f32,
    pub angle_increment: f32,
    pub time_increment: f32,
    pub scan_time: f32,
    pub range_min: f32,
    pub range_max: f32,
    pub ranges: Vec<f32>,
    pub intensities: Vec<f32>,
}

pub fn decode_laser_scan(bytes: &[u8]) -> Result<LaserScan, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let angle_min = r.f32()?;
    let angle_max = r.f32()?;
    let angle_increment = r.f32()?;
    let time_increment = r.f32()?;
    let scan_time = r.f32()?;
    let range_min = r.f32()?;
    let range_max = r.f32()?;
    let mut ranges = Vec::new();
    r.f32_seq_into(&mut ranges)?;
    let mut intensities = Vec::new();
    r.f32_seq_into(&mut intensities)?;
    Ok(LaserScan {
        header,
        angle_min,
        angle_max,
        angle_increment,
        time_increment,
        scan_time,
        range_min,
        range_max,
        ranges,
        intensities,
    })
}

/// livox_ros_driver2/msg/CustomMsg (what the Livox driver publishes with
/// `xfer_format: 1`), split into per-field columns. Layout:
///
/// ```text
/// CustomMsg:   std_msgs/Header header; uint64 timebase; uint32 point_num;
///              uint8 lidar_id; uint8[3] rsvd; CustomPoint[] points
/// CustomPoint: uint32 offset_time; float32 x, y, z;
///              uint8 reflectivity, tag, line
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct LivoxCustomMsg {
    pub header: Header,
    /// Time of the first point, ns.
    pub timebase: u64,
    /// Count the driver wrote; equals `xyz.len() / 3` for a well-formed message.
    pub point_num: u32,
    pub lidar_id: u8,
    /// xyz × n, metres in the lidar frame. Livox writes (0, 0, 0) for no return.
    pub xyz: Vec<f32>,
    /// Per-point offset from `timebase`, ns (exact up to 2^24).
    pub offset_time: Vec<f32>,
    /// 0–255.
    pub reflectivity: Vec<f32>,
    pub tag: Vec<f32>,
    /// Laser number within the lidar.
    pub line: Vec<f32>,
}

/// Bytes of one `CustomPoint` without the trailing pad: uint32 + 3 × float32 +
/// 3 × uint8. The next element's uint32 re-aligns to 4, so the stride is 20.
const LIVOX_POINT_BYTES: usize = 19;

pub fn decode_livox_custom_msg(bytes: &[u8]) -> Result<LivoxCustomMsg, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let timebase = r.u64()?;
    let point_num = r.u32()?;
    let lidar_id = r.u8()?;
    r.bytes(3)?; // rsvd
    let n = r.seq_len(LIVOX_POINT_BYTES)?;
    let mut m = LivoxCustomMsg {
        header,
        timebase,
        point_num,
        lidar_id,
        xyz: Vec::with_capacity(n * 3),
        offset_time: Vec::with_capacity(n),
        reflectivity: Vec::with_capacity(n),
        tag: Vec::with_capacity(n),
        line: Vec::with_capacity(n),
    };
    for _ in 0..n {
        let t = r.u32()?;
        let x = r.f32()?;
        let y = r.f32()?;
        let z = r.f32()?;
        let reflectivity = r.u8()?;
        let tag = r.u8()?;
        let line = r.u8()?;
        m.offset_time.push(t as f32);
        m.xyz.extend_from_slice(&[x, y, z]);
        m.reflectivity.push(reflectivity as f32);
        m.tag.push(tag as f32);
        m.line.push(line as f32);
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdr::Writer;

    pub fn write_cloud_xyzi(points: &[[f32; 4]], frame: &str) -> Vec<u8> {
        let mut w = Writer::new();
        w.i32(1).u32(0).string(frame);
        w.u32(1).u32(points.len() as u32);
        w.seq_len(4);
        for (i, name) in ["x", "y", "z", "intensity"].iter().enumerate() {
            w.string(name).u32(i as u32 * 4).u8(FLOAT32).u32(1);
        }
        w.bool(false).u32(16).u32(16 * points.len() as u32);
        w.seq_len(points.len() * 16);
        for p in points {
            for v in p {
                w.bytes(&v.to_le_bytes());
            }
        }
        w.bool(true);
        w.finish()
    }

    #[test]
    fn point_cloud2_fields_and_reads() {
        let bytes = write_cloud_xyzi(&[[1.0, 2.0, 3.0, 10.0], [4.0, 5.0, 6.0, 20.0]], "laser");
        let c = decode_point_cloud2(&bytes).unwrap();
        assert_eq!(c.point_count(), 2);
        assert_eq!(c.fields.len(), 4);
        let x = c.field("x").unwrap();
        let i = c.field("intensity").unwrap();
        assert_eq!(c.read_f32(x, 1), 4.0);
        assert_eq!(c.read_f32(i, 0), 10.0);
        assert!(c.field("rgb").is_none());
        assert_eq!(c.header.frame_id, "laser");
    }

    #[test]
    fn laser_scan_decodes() {
        let mut w = Writer::new();
        w.i32(1).u32(0).string("laser");
        w.f32(-1.0)
            .f32(1.0)
            .f32(0.5)
            .f32(0.0)
            .f32(0.1)
            .f32(0.1)
            .f32(10.0);
        w.f32_seq(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        w.f32_seq(&[]);
        let s = decode_laser_scan(&w.finish()).unwrap();
        assert_eq!(s.ranges.len(), 5);
        assert_eq!(s.angle_increment, 0.5);
        assert!(s.intensities.is_empty());
    }

    /// Writes a CustomMsg exactly as rosidl's CDR serializer would (20-byte point stride).
    pub fn write_livox(points: &[(u32, [f32; 3], [u8; 3])], frame: &str) -> Vec<u8> {
        let mut w = Writer::new();
        w.i32(1).u32(0).string(frame);
        w.u64(1_700_000_000_000_000_000)
            .u32(points.len() as u32)
            .u8(7);
        w.bytes(&[0, 0, 0]);
        w.seq_len(points.len());
        for (t, xyz, rtl) in points {
            w.u32(*t);
            for v in xyz {
                w.f32(*v);
            }
            w.bytes(rtl);
        }
        w.finish()
    }

    #[test]
    fn livox_custom_msg_decodes_with_20_byte_stride() {
        let bytes = write_livox(
            &[
                (0, [1.0, 2.0, 3.0], [200, 16, 1]),
                (1000, [0.0, 0.0, 0.0], [0, 0, 2]),
            ],
            "livox_frame",
        );
        // Payload: stamp(8) + string(4 + 12) = 24 (8-aligned already), timebase(8),
        // point_num(4), lidar_id(1), rsvd(3), seq len(4) = 44; then 20 + 19 bytes of points.
        assert_eq!(bytes.len(), 4 + 44 + 20 + 19);
        let m = decode_livox_custom_msg(&bytes).unwrap();
        assert_eq!(m.header.frame_id, "livox_frame");
        assert_eq!(m.timebase, 1_700_000_000_000_000_000);
        assert_eq!((m.point_num, m.lidar_id), (2, 7));
        assert_eq!(m.xyz, vec![1.0, 2.0, 3.0, 0.0, 0.0, 0.0]);
        assert_eq!(m.offset_time, vec![0.0, 1000.0]);
        assert_eq!(m.reflectivity, vec![200.0, 0.0]);
        assert_eq!(m.tag, vec![16.0, 0.0]);
        assert_eq!(m.line, vec![1.0, 2.0]);
        // A truncated point list is an error, not a panic.
        assert!(decode_livox_custom_msg(&bytes[..bytes.len() - 5]).is_err());
    }
}
