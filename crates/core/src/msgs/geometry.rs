//! geometry_msgs: Pose, PoseStamped, PoseArray, PoseWithCovarianceStamped, PointStamped, PolygonStamped

use super::common::{Header, read_quat, read_vec3};
use crate::cdr::{CdrError, Reader};
use crate::math::Transform;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

/// geometry_msgs/msg/Pose as a rigid transform (position + orientation).
pub fn read_pose(r: &mut Reader) -> Result<Transform, CdrError> {
    Ok(Transform::new(read_vec3(r)?, read_quat(r)?))
}

#[derive(Debug, Clone, PartialEq)]
pub struct PoseStamped {
    pub header: Header,
    pub pose: Transform,
}

pub fn decode_pose_stamped(bytes: &[u8]) -> Result<PoseStamped, CdrError> {
    let mut r = Reader::new(bytes)?;
    Ok(PoseStamped {
        header: Header::read(&mut r)?,
        pose: read_pose(&mut r)?,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PoseArray {
    pub header: Header,
    pub poses: Vec<Transform>,
}

/// Size of one serialized Pose (7 × f64, 8-aligned).
pub const POSE_SIZE: usize = 56;

pub fn decode_pose_array(bytes: &[u8]) -> Result<PoseArray, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let n = r.seq_len(POSE_SIZE)?;
    let mut poses = Vec::with_capacity(n);
    for _ in 0..n {
        poses.push(read_pose(&mut r)?);
    }
    Ok(PoseArray { header, poses })
}

/// 6×6 row-major covariance (x, y, z, roll, pitch, yaw).
pub fn read_covariance(r: &mut Reader) -> Result<[f64; 36], CdrError> {
    let mut c = [0.0; 36];
    for v in c.iter_mut() {
        *v = r.f64()?;
    }
    Ok(c)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PoseWithCovarianceStamped {
    pub header: Header,
    pub pose: Transform,
    pub covariance: [f64; 36],
}

pub fn decode_pose_with_covariance_stamped(
    bytes: &[u8],
) -> Result<PoseWithCovarianceStamped, CdrError> {
    let mut r = Reader::new(bytes)?;
    Ok(PoseWithCovarianceStamped {
        header: Header::read(&mut r)?,
        pose: read_pose(&mut r)?,
        covariance: read_covariance(&mut r)?,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PointStamped {
    pub header: Header,
    pub point: [f64; 3],
}

pub fn decode_point_stamped(bytes: &[u8]) -> Result<PointStamped, CdrError> {
    let mut r = Reader::new(bytes)?;
    Ok(PointStamped {
        header: Header::read(&mut r)?,
        point: read_vec3(&mut r)?,
    })
}

/// geometry_msgs/msg/PolygonStamped: Point32 vertices as flat xyz f32.
#[derive(Debug, Clone, PartialEq)]
pub struct PolygonStamped {
    pub header: Header,
    pub points: Vec<f32>,
}

pub fn decode_polygon_stamped(bytes: &[u8]) -> Result<PolygonStamped, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let n = r.seq_len(12)?;
    let mut points = Vec::with_capacity(n * 3);
    for _ in 0..n {
        points.push(r.f32()?);
        points.push(r.f32()?);
        points.push(r.f32()?);
    }
    Ok(PolygonStamped { header, points })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdr::Writer;

    #[test]
    fn pose_with_covariance_point_and_polygon() {
        let mut w = Writer::new();
        w.i32(1).u32(2).string("map");
        write_pose(
            &mut w,
            &Transform::new([1.0, 2.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
        );
        for i in 0..36 {
            w.f64(i as f64 * 0.5);
        }
        let p = decode_pose_with_covariance_stamped(&w.finish()).unwrap();
        assert_eq!(p.pose.t, [1.0, 2.0, 0.0]);
        assert_eq!(p.covariance[7], 3.5);
        assert_eq!(p.covariance[35], 17.5);
        // truncated covariance is an error
        let mut w = Writer::new();
        w.i32(1).u32(2).string("map");
        write_pose(&mut w, &Transform::IDENTITY);
        w.f64(1.0);
        assert!(decode_pose_with_covariance_stamped(&w.finish()).is_err());

        let mut w = Writer::new();
        w.i32(1)
            .u32(2)
            .string("base_link")
            .f64(0.5)
            .f64(-0.5)
            .f64(0.25);
        let pt = decode_point_stamped(&w.finish()).unwrap();
        assert_eq!(pt.point, [0.5, -0.5, 0.25]);

        let mut w = Writer::new();
        w.i32(1).u32(2).string("base_link").seq_len(3);
        for (x, y) in [(0.0f32, 0.0f32), (1.0, 0.0), (1.0, 1.0)] {
            w.f32(x).f32(y).f32(0.0);
        }
        let poly = decode_polygon_stamped(&w.finish()).unwrap();
        assert_eq!(poly.points.len(), 9);
        assert_eq!(&poly.points[3..6], &[1.0, 0.0, 0.0]);
    }

    pub fn write_pose(w: &mut Writer, t: &Transform) {
        for v in t.t {
            w.f64(v);
        }
        for v in t.q {
            w.f64(v);
        }
    }

    #[test]
    fn pose_stamped_and_array() {
        let p = Transform::new([1.0, 2.0, 3.0], [0.0, 0.0, 0.0, 1.0]);
        let mut w = Writer::new();
        w.i32(1).u32(2).string("map");
        write_pose(&mut w, &p);
        let ps = decode_pose_stamped(&w.finish()).unwrap();
        assert_eq!(ps.header.frame_id, "map");
        assert_eq!(ps.pose, p);

        let mut w = Writer::new();
        w.i32(1).u32(2).string("odom");
        w.seq_len(3);
        for i in 0..3 {
            write_pose(
                &mut w,
                &Transform::new([i as f64, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
            );
        }
        let pa = decode_pose_array(&w.finish()).unwrap();
        assert_eq!(pa.poses.len(), 3);
        assert_eq!(pa.poses[2].t, [2.0, 0.0, 0.0]);
        // corrupt length is rejected before allocating
        let mut w = Writer::new();
        w.i32(1).u32(2).string("odom").u32(1_000_000);
        assert!(decode_pose_array(&w.finish()).is_err());
    }
}
