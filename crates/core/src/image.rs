//! sensor_msgs/Image → RGBA8 (rviz ROSImageTexture): colour encodings are
//! expanded, single-channel depth / mono images are normalised to grey with
//! either a fixed range or a running median of per-frame min/max bounds.

use crate::msgs::sensor::Image;
#[cfg(not(feature = "std"))]
use alloc::{collections::VecDeque, string::String, vec::Vec};
#[cfg(feature = "std")]
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DepthOptions {
    /// Normalise each frame to its own [min, max] (median over `median_window` frames).
    pub normalize: bool,
    pub min: f32,
    pub max: f32,
    pub median_window: usize,
}

impl Default for DepthOptions {
    fn default() -> Self {
        Self {
            normalize: true,
            min: 0.0,
            max: 1.0,
            median_window: 5,
        }
    }
}

/// Per-subscription state for the running median of depth bounds.
#[derive(Debug, Default, Clone)]
pub struct ImageNormalizer {
    mins: VecDeque<f32>,
    maxs: VecDeque<f32>,
}

impl ImageNormalizer {
    pub fn new() -> Self {
        Self::default()
    }

    fn median(values: &VecDeque<f32>) -> f32 {
        let mut v: Vec<f32> = values.iter().copied().collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        v[v.len() / 2]
    }

    /// Updates the history with this frame's bounds and returns the bounds to use.
    fn bounds(&mut self, frame_min: f32, frame_max: f32, window: usize) -> (f32, f32) {
        let window = window.max(1);
        self.mins.push_back(frame_min);
        self.maxs.push_back(frame_max);
        while self.mins.len() > window {
            self.mins.pop_front();
            self.maxs.pop_front();
        }
        (Self::median(&self.mins), Self::median(&self.maxs))
    }
}

/// Reads a pixel row-wise with the message's `step`, handling truncated buffers.
fn row<'a>(img: &Image<'a>, y: usize, bytes_per_px: usize) -> Option<&'a [u8]> {
    let step = img.step as usize;
    let start = y * step;
    let len = img.width as usize * bytes_per_px;
    img.data.get(start..start + len)
}

fn read_u16(b: &[u8], big: bool) -> u16 {
    if big {
        u16::from_be_bytes([b[0], b[1]])
    } else {
        u16::from_le_bytes([b[0], b[1]])
    }
}

fn read_f32(b: &[u8], big: bool) -> f32 {
    let a = [b[0], b[1], b[2], b[3]];
    if big {
        f32::from_be_bytes(a)
    } else {
        f32::from_le_bytes(a)
    }
}

/// Converts `img` into `out` (RGBA8, `width * height * 4`). Returns the
/// encoding family handled, or an error for unsupported encodings / short data.
pub fn to_rgba8(
    img: &Image,
    opts: &DepthOptions,
    state: &mut ImageNormalizer,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    let w = img.width as usize;
    let h = img.height as usize;
    if w == 0 || h == 0 {
        return Err("empty image".into());
    }
    out.clear();
    out.resize(w * h * 4, 255);
    let enc = img.encoding.as_str();
    match enc {
        "rgb8" | "8UC3" | "bgr8" => {
            let bgr = enc == "bgr8";
            for y in 0..h {
                let r = row(img, y, 3).ok_or("image data shorter than width * height * step")?;
                let o = &mut out[y * w * 4..(y + 1) * w * 4];
                for x in 0..w {
                    let (a, b, c) = (r[x * 3], r[x * 3 + 1], r[x * 3 + 2]);
                    o[x * 4] = if bgr { c } else { a };
                    o[x * 4 + 1] = b;
                    o[x * 4 + 2] = if bgr { a } else { c };
                }
            }
        }
        "rgba8" | "8UC4" | "bgra8" => {
            let bgr = enc == "bgra8";
            for y in 0..h {
                let r = row(img, y, 4).ok_or("image data shorter than width * height * step")?;
                let o = &mut out[y * w * 4..(y + 1) * w * 4];
                for x in 0..w {
                    o[x * 4] = if bgr { r[x * 4 + 2] } else { r[x * 4] };
                    o[x * 4 + 1] = r[x * 4 + 1];
                    o[x * 4 + 2] = if bgr { r[x * 4] } else { r[x * 4 + 2] };
                    o[x * 4 + 3] = r[x * 4 + 3];
                }
            }
        }
        "mono8" | "8UC1" => {
            for y in 0..h {
                let r = row(img, y, 1).ok_or("image data shorter than width * height * step")?;
                let o = &mut out[y * w * 4..(y + 1) * w * 4];
                for x in 0..w {
                    o[x * 4] = r[x];
                    o[x * 4 + 1] = r[x];
                    o[x * 4 + 2] = r[x];
                }
            }
        }
        "mono16" | "16UC1" | "32FC1" => {
            let is_f32 = enc == "32FC1";
            let bpp = if is_f32 { 4 } else { 2 };
            // Pass 1: bounds over finite, non-zero values (rviz skips 0 / NaN depth).
            let mut fmin = f32::INFINITY;
            let mut fmax = f32::NEG_INFINITY;
            if opts.normalize {
                for y in 0..h {
                    let r =
                        row(img, y, bpp).ok_or("image data shorter than width * height * step")?;
                    for x in 0..w {
                        let v = if is_f32 {
                            read_f32(&r[x * 4..], img.is_bigendian)
                        } else {
                            read_u16(&r[x * 2..], img.is_bigendian) as f32
                        };
                        if v.is_finite() && v != 0.0 {
                            fmin = fmin.min(v);
                            fmax = fmax.max(v);
                        }
                    }
                }
            }
            let (lo, hi) = if opts.normalize {
                if fmin.is_finite() && fmax.is_finite() {
                    state.bounds(fmin, fmax, opts.median_window)
                } else {
                    (0.0, 1.0)
                }
            } else {
                (opts.min, opts.max)
            };
            let span = if hi > lo { hi - lo } else { 1.0 };
            for y in 0..h {
                let r = row(img, y, bpp).ok_or("image data shorter than width * height * step")?;
                let o = &mut out[y * w * 4..(y + 1) * w * 4];
                for x in 0..w {
                    let v = if is_f32 {
                        read_f32(&r[x * 4..], img.is_bigendian)
                    } else {
                        read_u16(&r[x * 2..], img.is_bigendian) as f32
                    };
                    let g = if v.is_finite() && v != 0.0 {
                        (((v - lo) / span).clamp(0.0, 1.0) * 255.0) as u8
                    } else {
                        0
                    };
                    o[x * 4] = g;
                    o[x * 4 + 1] = g;
                    o[x * 4 + 2] = g;
                }
            }
        }
        other => return Err(format_unsupported(other)),
    }
    Ok(())
}

fn format_unsupported(enc: &str) -> String {
    let mut s = String::from("unsupported image encoding [");
    s.push_str(enc);
    s.push_str("]; supported: rgb8 rgba8 bgr8 bgra8 mono8 mono16 8UC1 8UC3 8UC4 16UC1 32FC1");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msgs::Header;

    fn img<'a>(w: u32, h: u32, enc: &str, bpp: u32, data: &'a [u8]) -> Image<'a> {
        Image {
            header: Header::default(),
            height: h,
            width: w,
            encoding: enc.into(),
            is_bigendian: false,
            step: w * bpp,
            data,
        }
    }

    #[test]
    fn colour_encodings() {
        let mut out = Vec::new();
        let mut st = ImageNormalizer::new();
        let d = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        to_rgba8(
            &img(2, 2, "rgb8", 3, &d),
            &DepthOptions::default(),
            &mut st,
            &mut out,
        )
        .unwrap();
        assert_eq!(&out[..4], &[1, 2, 3, 255]);
        assert_eq!(&out[12..16], &[10, 11, 12, 255]);
        to_rgba8(
            &img(2, 2, "bgr8", 3, &d),
            &DepthOptions::default(),
            &mut st,
            &mut out,
        )
        .unwrap();
        assert_eq!(&out[..4], &[3, 2, 1, 255]);
        let d4 = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        to_rgba8(
            &img(2, 2, "bgra8", 4, &d4),
            &DepthOptions::default(),
            &mut st,
            &mut out,
        )
        .unwrap();
        assert_eq!(&out[..4], &[3, 2, 1, 4]);
        to_rgba8(
            &img(2, 2, "mono8", 1, &d[..4]),
            &DepthOptions::default(),
            &mut st,
            &mut out,
        )
        .unwrap();
        assert_eq!(&out[4..8], &[2, 2, 2, 255]);
        assert!(
            to_rgba8(
                &img(2, 2, "yuv422", 2, &d),
                &DepthOptions::default(),
                &mut st,
                &mut out
            )
            .is_err()
        );
        assert!(
            to_rgba8(
                &img(4, 4, "rgb8", 3, &d),
                &DepthOptions::default(),
                &mut st,
                &mut out
            )
            .is_err()
        );
    }

    #[test]
    fn depth_normalisation_and_median_window() {
        let mut out = Vec::new();
        let mut st = ImageNormalizer::new();
        // 16UC1: 0 (invalid), 1000, 2000, 3000 mm
        let mut d = Vec::new();
        for v in [0u16, 1000, 2000, 3000] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        let opts = DepthOptions {
            normalize: true,
            min: 0.0,
            max: 1.0,
            median_window: 3,
        };
        to_rgba8(&img(4, 1, "16UC1", 2, &d), &opts, &mut st, &mut out).unwrap();
        assert_eq!(out[0], 0); // invalid → black
        assert_eq!(out[4], 0); // min → 0
        assert_eq!(out[12], 255); // max → 255
        assert!(out[8] > 120 && out[8] < 135);
        // fixed range
        let fixed = DepthOptions {
            normalize: false,
            min: 0.0,
            max: 4000.0,
            median_window: 3,
        };
        to_rgba8(&img(4, 1, "16UC1", 2, &d), &fixed, &mut st, &mut out).unwrap();
        assert!((out[12] as i32 - 191).abs() <= 1);
        // median window: a one-frame spike in max does not move the median
        let mut spike = Vec::new();
        for v in [1000u16, 60000, 2000, 3000] {
            spike.extend_from_slice(&v.to_le_bytes());
        }
        to_rgba8(&img(4, 1, "16UC1", 2, &d), &opts, &mut st, &mut out).unwrap();
        to_rgba8(&img(4, 1, "16UC1", 2, &spike), &opts, &mut st, &mut out).unwrap();
        // history: maxs [3000, 3000, 60000] → median 3000, so 3000 still maps to 255
        assert_eq!(out[12], 255);
        // 32FC1 with NaN
        let mut f = Vec::new();
        for v in [f32::NAN, 0.5, 1.0, 1.5] {
            f.extend_from_slice(&v.to_le_bytes());
        }
        let mut st2 = ImageNormalizer::new();
        to_rgba8(&img(4, 1, "32FC1", 4, &f), &opts, &mut st2, &mut out).unwrap();
        assert_eq!(out[0], 0);
        assert_eq!(out[12], 255);
    }
}
