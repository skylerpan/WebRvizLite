//! geometry_msgs: Pose, PoseStamped, PoseArray

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdr::Writer;

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
