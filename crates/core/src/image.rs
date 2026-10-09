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
        "rgb8" | "8UC3" | "8SC3" | "bgr8" => {
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
        "rgba8" | "8UC4" | "8SC4" | "bgra8" => {
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
        // bayer_* is shown raw as grey, like rviz.
        e if e == "mono8" || e == "8UC1" || e == "8SC1" || e.starts_with("bayer") => {
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
        // 16SC1 is read as unsigned, as rviz does.
        "mono16" | "16UC1" | "16SC1" | "32FC1" => {
            let is_f32 = enc == "32FC1";
            let bpp = if is_f32 { 4 } else { 2 };
            // Pass 1: bounds over finite values (rviz compares with std::min/max, so only NaN drops out).
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
                        if v.is_finite() {
                            fmin = fmin.min(v);
                            fmax = fmax.max(v);
                        }
                    }
                }
            }
            let (lo, hi) = if opts.normalize {
                if fmin.is_finite() && fmax.is_finite() {
                    if opts.median_window > 1 {
                        state.bounds(fmin, fmax, opts.median_window)
                    } else {
                        (fmin, fmax)
                    }
                } else {
                    (f32::NAN, f32::NAN)
                }
            } else {
                (opts.min, opts.max)
            };
            // rviz: a non-positive or non-finite range gives a black frame.
            let span = hi - lo;
            let valid = span.is_finite() && span > 0.0;
            for y in 0..h {
                let r = row(img, y, bpp).ok_or("image data shorter than width * height * step")?;
                let o = &mut out[y * w * 4..(y + 1) * w * 4];
                for x in 0..w {
                    let v = if is_f32 {
                        read_f32(&r[x * 4..], img.is_bigendian)
                    } else {
                        read_u16(&r[x * 2..], img.is_bigendian) as f32
                    };
                    let g = if valid && v.is_finite() {
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
        "yuyv" | "uyvy" => {
            let swap = enc == "uyvy"; // uyvy: U Y0 V Y1; yuyv: Y0 U Y1 V
            for y in 0..h {
                let r = row(img, y, 2).ok_or("image data shorter than width * height * step")?;
                let o = &mut out[y * w * 4..(y + 1) * w * 4];
                for x in (0..w).step_by(2) {
                    let b = &r[x * 2..];
                    let (y0, u, y1, v) = if swap {
                        (b[1], b[0], b.get(3).copied().unwrap_or(b[1]), b[2])
                    } else {
                        (b[0], b[1], b.get(2).copied().unwrap_or(b[0]), b[3])
                    };
                    yuv_to_rgb(y0, u, v, &mut o[x * 4..x * 4 + 3]);
                    if x + 1 < w {
                        yuv_to_rgb(y1, u, v, &mut o[(x + 1) * 4..(x + 1) * 4 + 3]);
                    }
                }
            }
        }
        "nv12" => {
            // Y plane (h rows, step bytes) followed by interleaved UV at half resolution.
            let y_size = img.step as usize * h;
            let uv = img
                .data
                .get(y_size..)
                .ok_or("nv12 image shorter than its Y plane")?;
            for y in 0..h {
                let r = row(img, y, 1).ok_or("image data shorter than width * height * step")?;
                let uv_row = &uv[(y / 2) * img.step as usize..];
                let o = &mut out[y * w * 4..(y + 1) * w * 4];
                for x in 0..w {
                    let (u, v) = (
                        uv_row.get((x / 2) * 2).copied().unwrap_or(128),
                        uv_row.get((x / 2) * 2 + 1).copied().unwrap_or(128),
                    );
                    yuv_to_rgb(r[x], u, v, &mut o[x * 4..x * 4 + 3]);
                }
            }
        }
        other => return Err(format_unsupported(other)),
    }
    Ok(())
}

/// BT.601 full-range YUV → RGB, as rviz's conversions.
fn yuv_to_rgb(y: u8, u: u8, v: u8, out: &mut [u8]) {
    let (yf, uf, vf) = (y as f32, u as f32 - 128.0, v as f32 - 128.0);
    out[0] = (yf + 1.402 * vf).clamp(0.0, 255.0) as u8;
    out[1] = (yf - 0.344 * uf - 0.714 * vf).clamp(0.0, 255.0) as u8;
    out[2] = (yf + 1.772 * uf).clamp(0.0, 255.0) as u8;
}

fn format_unsupported(enc: &str) -> String {
    let mut s = String::from("unsupported image encoding [");
    s.push_str(enc);
    s.push_str("]; supported: rgb8 rgba8 bgr8 bgra8 mono8 mono16 8UC1 8UC3 8UC4 8SC1 8SC3 8SC4 16UC1 16SC1 32FC1 bayer_* yuyv uyvy nv12");
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
        // rviz does not skip zeros: 0 is the frame minimum → black, 3000 → white, 1000 → 85
        assert_eq!(out[0], 0);
        assert!((out[4] as i32 - 85).abs() <= 1);
        assert_eq!(out[12], 255);
        assert!((out[8] as i32 - 170).abs() <= 1);
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
        // median window 1 uses the frame's own bounds
        let one = DepthOptions {
            normalize: true,
            min: 0.0,
            max: 1.0,
            median_window: 1,
        };
        to_rgba8(&img(4, 1, "16UC1", 2, &spike), &one, &mut st, &mut out).unwrap();
        assert_eq!(out[4], 255);
        // yuyv: two grey pixels (Y=128, U=V=128) → mid grey
        let yuyv = [128u8, 128, 128, 128];
        to_rgba8(&img(2, 1, "yuyv", 2, &yuyv), &one, &mut st, &mut out).unwrap();
        assert_eq!(&out[..3], &[128, 128, 128]);
        // bayer shows raw grey
        to_rgba8(
            &img(2, 1, "bayer_rggb8", 1, &[10u8, 200]),
            &one,
            &mut st,
            &mut out,
        )
        .unwrap();
        assert_eq!(out[4], 200);
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
