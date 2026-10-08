//! sensor_msgs: Range (Image / CameraInfo are added in M14).

use super::common::Header;
use crate::cdr::{CdrError, Reader};

/// sensor_msgs/msg/Range. `variance` is only present in newer distros; it is
/// read when the payload has it.
#[derive(Debug, Clone, PartialEq)]
pub struct Range {
    pub header: Header,
    pub radiation_type: u8,
    pub field_of_view: f32,
    pub min_range: f32,
    pub max_range: f32,
    pub range: f32,
    pub variance: Option<f32>,
}

pub fn decode_range(bytes: &[u8]) -> Result<Range, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let radiation_type = r.u8()?;
    let field_of_view = r.f32()?;
    let min_range = r.f32()?;
    let max_range = r.f32()?;
    let range = r.f32()?;
    let variance = if r.remaining() >= 4 {
        Some(r.f32()?)
    } else {
        None
    };
    Ok(Range {
        header,
        radiation_type,
        field_of_view,
        min_range,
        max_range,
        range,
        variance,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdr::Writer;

    #[test]
    fn range_with_and_without_variance() {
        let mut w = Writer::new();
        w.i32(1)
            .u32(0)
            .string("sonar")
            .u8(0)
            .f32(0.5)
            .f32(0.02)
            .f32(4.0)
            .f32(1.25);
        let r = decode_range(&w.finish()).unwrap();
        assert_eq!((r.radiation_type, r.field_of_view, r.range), (0, 0.5, 1.25));
        assert_eq!(r.variance, None);
        let mut w = Writer::new();
        w.i32(1)
            .u32(0)
            .string("sonar")
            .u8(1)
            .f32(0.5)
            .f32(0.02)
            .f32(4.0)
            .f32(1.25)
            .f32(0.01);
        assert_eq!(decode_range(&w.finish()).unwrap().variance, Some(0.01));
        let mut w = Writer::new();
        w.i32(1).u32(0).string("sonar").u8(0).f32(0.5);
        assert!(decode_range(&w.finish()).is_err());
    }
}
