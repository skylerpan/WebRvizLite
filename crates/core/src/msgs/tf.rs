//! tf2_msgs/msg/TFMessage

use super::common::{Header, read_quat, read_vec3};
use crate::cdr::{CdrError, Reader};
use crate::math::Transform;
#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

#[derive(Debug, Clone, PartialEq)]
pub struct TransformStamped {
    pub header: Header,
    pub child_frame_id: String,
    pub transform: Transform,
}

pub fn decode_tf_message(bytes: &[u8]) -> Result<Vec<TransformStamped>, CdrError> {
    let mut r = Reader::new(bytes)?;
    let n = r.seq_len(4 + 4 + 4 + 4 + 56)?; // minimum size of one TransformStamped
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let header = Header::read(&mut r)?;
        let child_frame_id = r.string()?;
        let t = read_vec3(&mut r)?;
        let q = read_quat(&mut r)?;
        out.push(TransformStamped {
            header,
            child_frame_id,
            transform: Transform::new(t, q),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdr::Writer;

    #[test]
    fn decodes_two_transforms() {
        let mut w = Writer::new();
        w.seq_len(2);
        for (p, c, x) in [("map", "odom", 1.0f64), ("odom", "base_link", 2.0)] {
            w.i32(5).u32(6).string(p).string(c);
            w.f64(x).f64(0.0).f64(0.0);
            w.f64(0.0).f64(0.0).f64(0.0).f64(1.0);
        }
        let v = decode_tf_message(&w.finish()).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].header.frame_id, "odom");
        assert_eq!(v[1].child_frame_id, "base_link");
        assert_eq!(v[1].transform.t, [2.0, 0.0, 0.0]);
        assert_eq!(v[0].header.stamp.to_ns(), 5_000_000_006);
    }
}
