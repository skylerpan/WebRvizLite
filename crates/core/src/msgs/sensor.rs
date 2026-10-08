//! sensor_msgs: Range, Image, CameraInfo.

use super::common::Header;
use crate::cdr::{CdrError, Reader};
#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

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

/// sensor_msgs/msg/Image with the pixel buffer borrowed from the CDR payload.
#[derive(Debug, Clone, PartialEq)]
pub struct Image<'a> {
    pub header: Header,
    pub height: u32,
    pub width: u32,
    pub encoding: String,
    pub is_bigendian: bool,
    pub step: u32,
    pub data: &'a [u8],
}

pub fn decode_image(bytes: &[u8]) -> Result<Image<'_>, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let height = r.u32()?;
    let width = r.u32()?;
    let encoding = r.string()?;
    let is_bigendian = r.u8()? != 0;
    let step = r.u32()?;
    let n = r.seq_len(1)?;
    let data = r.bytes(n)?;
    Ok(Image {
        header,
        height,
        width,
        encoding,
        is_bigendian,
        step,
        data,
    })
}

/// sensor_msgs/msg/CameraInfo (intrinsics only; `d` is kept for completeness).
#[derive(Debug, Clone, PartialEq)]
pub struct CameraInfo {
    pub header: Header,
    pub height: u32,
    pub width: u32,
    pub distortion_model: String,
    pub d: Vec<f64>,
    pub k: [f64; 9],
    pub r: [f64; 9],
    pub p: [f64; 12],
    pub binning_x: u32,
    pub binning_y: u32,
    /// x_offset, y_offset, height, width
    pub roi: [u32; 4],
    pub do_rectify: bool,
}

pub fn decode_camera_info(bytes: &[u8]) -> Result<CameraInfo, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let height = r.u32()?;
    let width = r.u32()?;
    let distortion_model = r.string()?;
    let nd = r.seq_len(8)?;
    let mut d = Vec::with_capacity(nd);
    for _ in 0..nd {
        d.push(r.f64()?);
    }
    let mut k = [0.0; 9];
    for v in k.iter_mut() {
        *v = r.f64()?;
    }
    let mut rr = [0.0; 9];
    for v in rr.iter_mut() {
        *v = r.f64()?;
    }
    let mut p = [0.0; 12];
    for v in p.iter_mut() {
        *v = r.f64()?;
    }
    let binning_x = r.u32()?;
    let binning_y = r.u32()?;
    let roi = [r.u32()?, r.u32()?, r.u32()?, r.u32()?];
    let do_rectify = r.bool()?;
    Ok(CameraInfo {
        header,
        height,
        width,
        distortion_model,
        d,
        k,
        r: rr,
        p,
        binning_x,
        binning_y,
        roi,
        do_rectify,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdr::Writer;

    #[test]
    fn image_and_camera_info() {
        let mut w = Writer::new();
        w.i32(1)
            .u32(0)
            .string("cam")
            .u32(2)
            .u32(3)
            .string("rgb8")
            .u8(0)
            .u32(9);
        w.seq_len(18).bytes(&[1u8; 18]);
        let bytes = w.finish();
        let img = decode_image(&bytes).unwrap();
        assert_eq!((img.width, img.height, img.step), (3, 2, 9));
        assert_eq!(img.encoding, "rgb8");
        assert_eq!(img.data.len(), 18);
        let mut w = Writer::new();
        w.i32(1)
            .u32(0)
            .string("cam")
            .u32(2)
            .u32(3)
            .string("rgb8")
            .u8(0)
            .u32(9)
            .u32(100);
        assert!(decode_image(&w.finish()).is_err());

        let mut w = Writer::new();
        w.i32(1)
            .u32(0)
            .string("cam")
            .u32(120)
            .u32(160)
            .string("plumb_bob")
            .seq_len(5);
        for _ in 0..5 {
            w.f64(0.0);
        }
        for v in [120.0, 0.0, 80.0, 0.0, 120.0, 60.0, 0.0, 0.0, 1.0] {
            w.f64(v);
        }
        for i in 0..9 {
            w.f64(if i % 4 == 0 { 1.0 } else { 0.0 });
        }
        for v in [
            120.0, 0.0, 80.0, 0.0, 0.0, 120.0, 60.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        ] {
            w.f64(v);
        }
        w.u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).bool(false);
        let ci = decode_camera_info(&w.finish()).unwrap();
        assert_eq!((ci.width, ci.height), (160, 120));
        assert_eq!(ci.k[0], 120.0);
        assert_eq!(ci.k[2], 80.0);
        assert_eq!(ci.p[6], 60.0);
        assert_eq!(ci.distortion_model, "plumb_bob");
    }

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
