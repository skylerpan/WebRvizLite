//! Point cloud pipeline (spec §6.5): extract points from PointCloud2 /
//! LaserScan, transform them into the fixed frame, and colour them with one of
//! the RViz colour transformers. Runs in the worker (WASM); the output is
//! uploaded to the GPU unchanged.

use crate::math::Transform;
use crate::msgs::pointcloud::{FLOAT32, FLOAT64, LaserScan, PointCloud2, UINT32};
#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Transformer {
    FlatColor,
    AxisColor,
    #[default]
    Intensity,
    Rgb8,
    RgbF32,
}

impl Transformer {
    /// Display names as RViz shows them in the Color Transformer dropdown.
    pub fn name(self) -> &'static str {
        match self {
            Transformer::FlatColor => "FlatColor",
            Transformer::AxisColor => "AxisColor",
            Transformer::Intensity => "Intensity",
            Transformer::Rgb8 => "RGB8",
            Transformer::RgbF32 => "RGBF32",
        }
    }

    pub fn from_name(s: &str) -> Option<Self> {
        Some(match s {
            "FlatColor" => Transformer::FlatColor,
            "AxisColor" => Transformer::AxisColor,
            "Intensity" => Transformer::Intensity,
            "RGB8" => Transformer::Rgb8,
            "RGBF32" => Transformer::RgbF32,
            _ => return None,
        })
    }

    /// rviz scores: RGB8 5, Intensity 3, AxisColor 1, FlatColor 0 (highest wins when unset).
    pub fn score(self) -> u8 {
        match self {
            Transformer::Rgb8 | Transformer::RgbF32 => 5,
            Transformer::Intensity => 3,
            Transformer::AxisColor => 1,
            Transformer::FlatColor => 0,
        }
    }
}

/// Colour transformer settings, mirroring the RViz property names.
#[derive(Debug, Clone, PartialEq)]
pub struct ColorOptions {
    pub transformer: Transformer,
    // FlatColor
    pub flat_color: [u8; 3],
    // AxisColor
    pub axis: u8, // 0 = X, 1 = Y, 2 = Z
    pub axis_autocompute: bool,
    pub axis_min: f32,
    pub axis_max: f32,
    pub axis_use_fixed_frame: bool,
    // Intensity
    pub channel: String,
    pub use_rainbow: bool,
    pub invert_rainbow: bool,
    pub min_color: [u8; 3],
    pub max_color: [u8; 3],
    pub intensity_autocompute: bool,
    pub min_intensity: f32,
    pub max_intensity: f32,
}

impl Default for ColorOptions {
    fn default() -> Self {
        Self {
            transformer: Transformer::Intensity,
            flat_color: [255, 255, 255],
            axis: 2,
            axis_autocompute: true,
            axis_min: -10.0,
            axis_max: 10.0,
            axis_use_fixed_frame: true,
            channel: String::from("intensity"),
            use_rainbow: true,
            invert_rainbow: false,
            min_color: [0, 0, 0],
            max_color: [255, 255, 255],
            intensity_autocompute: true,
            min_intensity: 0.0,
            max_intensity: 4096.0,
        }
    }
}

/// Flat point set in the message frame.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Points {
    /// xyz × n
    pub xyz: Vec<f32>,
    /// Named scalar channels (intensity, ring, …), each n long.
    pub channels: Vec<(String, Vec<f32>)>,
    /// Packed 0x00RRGGBB per point when the cloud has an rgb/rgba field.
    pub rgb: Option<Vec<u32>>,
    /// Float r/g/b channels present (RGBF32).
    pub rgb_f32: bool,
}

impl Points {
    pub fn len(&self) -> usize {
        self.xyz.len() / 3
    }
    pub fn is_empty(&self) -> bool {
        self.xyz.is_empty()
    }
    pub fn channel(&self, name: &str) -> Option<&[f32]> {
        self.channels
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_slice())
    }
    /// Which transformers make sense for this point set (RViz: supports()).
    pub fn available_transformers(&self) -> Vec<Transformer> {
        let mut v = Vec::with_capacity(5);
        v.push(Transformer::FlatColor);
        v.push(Transformer::AxisColor);
        if !self.channels.is_empty() {
            v.push(Transformer::Intensity);
        }
        if self.rgb.is_some() {
            v.push(Transformer::Rgb8);
        }
        if self.rgb_f32 {
            v.push(Transformer::RgbF32);
        }
        v
    }
}

/// Extracts xyz and all scalar channels from a PointCloud2. Points with a
/// non-finite coordinate are dropped (rviz behaviour), so the output may be
/// shorter than the message.
pub fn points_from_cloud2(c: &PointCloud2) -> Result<Points, &'static str> {
    let (Some(fx), Some(fy), Some(fz)) = (c.field("x"), c.field("y"), c.field("z")) else {
        return Err("cloud has no x/y/z fields");
    };
    let n = c.point_count();
    let mut out = Points {
        xyz: Vec::with_capacity(n * 3),
        ..Default::default()
    };
    let rgb_field = c.field("rgb").or_else(|| c.field("rgba"));
    let rgb_f32 = c.field("r").is_some() && c.field("g").is_some() && c.field("b").is_some();
    let scalar_fields: Vec<_> = c
        .fields
        .iter()
        .filter(|f| !matches!(f.name.as_str(), "x" | "y" | "z" | "rgb" | "rgba") && f.count == 1)
        .collect();
    let mut channels: Vec<(String, Vec<f32>)> = scalar_fields
        .iter()
        .map(|f| (f.name.clone(), Vec::with_capacity(n)))
        .collect();
    let mut rgb: Option<Vec<u32>> = rgb_field.map(|_| Vec::with_capacity(n));
    for i in 0..n {
        let x = c.read_f32(fx, i);
        let y = c.read_f32(fy, i);
        let z = c.read_f32(fz, i);
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            continue;
        }
        out.xyz.extend_from_slice(&[x, y, z]);
        for (k, f) in scalar_fields.iter().enumerate() {
            channels[k].1.push(c.read_f32(f, i));
        }
        if let (Some(v), Some(f)) = (rgb.as_mut(), rgb_field) {
            // PCL packs rgb into a float32's bits; some publishers use uint32. Both are bit patterns.
            let bits = if f.datatype == FLOAT32 || f.datatype == UINT32 {
                c.read_u32_bits(f, i)
            } else {
                c.read_f32(f, i) as u32
            };
            v.push(bits & 0x00ff_ffff);
        }
    }
    out.channels = channels;
    out.rgb = rgb;
    out.rgb_f32 = rgb_f32;
    // FLOAT64 xyz would also work through read_f32; nothing else to do.
    let _ = FLOAT64;
    Ok(out)
}

/// laser_geometry-style projection: one point per valid range, plus an
/// "intensity" channel when the scan has intensities.
pub fn points_from_laser_scan(s: &LaserScan) -> Points {
    let n = s.ranges.len();
    let mut out = Points {
        xyz: Vec::with_capacity(n * 3),
        ..Default::default()
    };
    let has_intensity = s.intensities.len() == n;
    let mut intensity = Vec::with_capacity(if has_intensity { n } else { 0 });
    for (i, &r) in s.ranges.iter().enumerate() {
        if !r.is_finite() || r < s.range_min || r > s.range_max {
            continue;
        }
        let a = s.angle_min + i as f32 * s.angle_increment;
        out.xyz
            .extend_from_slice(&[r * libm::cosf(a), r * libm::sinf(a), 0.0]);
        if has_intensity {
            intensity.push(s.intensities[i]);
        }
    }
    if has_intensity {
        out.channels.push((String::from("intensity"), intensity));
    }
    out
}

/// rviz getRainbowColor: 0 → blue … 1 → red.
pub fn rainbow(value: f32) -> [u8; 3] {
    let value = value.clamp(0.0, 1.0);
    let h = value * 5.0 + 1.0;
    let i = libm::floorf(h) as i32;
    let mut f = h - i as f32;
    if i & 1 == 0 {
        f = 1.0 - f;
    }
    let n = 1.0 - f;
    let (r, g, b) = match i {
        i if i <= 1 => (n, 0.0, 1.0),
        2 => (0.0, n, 1.0),
        3 => (0.0, 1.0, n),
        4 => (n, 1.0, 0.0),
        _ => (1.0, n, 0.0),
    };
    [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
}

fn lerp_color(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    [
        (a[0] as f32 + (b[0] as f32 - a[0] as f32) * t) as u8,
        (a[1] as f32 + (b[1] as f32 - a[1] as f32) * t) as u8,
        (a[2] as f32 + (b[2] as f32 - a[2] as f32) * t) as u8,
    ]
}

fn min_max(values: impl Iterator<Item = f32>) -> (f32, f32) {
    let mut lo = f32::INFINITY;
    let mut hi = f32::NEG_INFINITY;
    for v in values {
        if v.is_finite() {
            lo = lo.min(v);
            hi = hi.max(v);
        }
    }
    if lo > hi { (0.0, 0.0) } else { (lo, hi) }
}

/// Output of [`build_cloud`]: ready for `BufferAttribute`s.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CloudOutput {
    pub positions: Vec<f32>,
    /// rgb × n
    pub colors: Vec<u8>,
    pub count: usize,
    /// Transformer actually applied (may differ from the request when unsupported).
    pub transformer: Transformer,
    /// Bounds used for Intensity / AxisColor (computed or configured).
    pub min: f32,
    pub max: f32,
}

/// Transforms `pts` with `tf` (message → fixed frame) and colours them.
pub fn build_cloud(pts: &Points, tf: &Transform, opts: &ColorOptions) -> CloudOutput {
    let n = pts.len();
    let mut positions = Vec::with_capacity(n * 3);
    for p in pts.xyz.as_chunks::<3>().0 {
        let q = tf.apply_point([p[0] as f64, p[1] as f64, p[2] as f64]);
        positions.extend_from_slice(&[q[0] as f32, q[1] as f32, q[2] as f32]);
    }

    let available = pts.available_transformers();
    let transformer = if available.contains(&opts.transformer) {
        opts.transformer
    } else {
        *available
            .iter()
            .max_by_key(|t| t.score())
            .unwrap_or(&Transformer::FlatColor)
    };

    let mut colors = Vec::with_capacity(n * 3);
    let (mut lo, mut hi) = (0.0f32, 0.0f32);
    match transformer {
        Transformer::FlatColor => {
            for _ in 0..n {
                colors.extend_from_slice(&opts.flat_color);
            }
        }
        Transformer::AxisColor => {
            let axis = (opts.axis.min(2)) as usize;
            let src = if opts.axis_use_fixed_frame {
                &positions
            } else {
                &pts.xyz
            };
            let values = src.as_chunks::<3>().0.iter().map(|p| p[axis]);
            (lo, hi) = if opts.axis_autocompute {
                min_max(values.clone())
            } else {
                (opts.axis_min, opts.axis_max)
            };
            let range = if hi > lo { hi - lo } else { 1.0 };
            for v in values {
                colors.extend_from_slice(&rainbow((v - lo) / range));
            }
        }
        Transformer::Intensity => {
            let channel = pts
                .channel(&opts.channel)
                .or_else(|| pts.channels.first().map(|(_, v)| v.as_slice()))
                .unwrap_or(&[]);
            (lo, hi) = if opts.intensity_autocompute {
                min_max(channel.iter().copied())
            } else {
                (opts.min_intensity, opts.max_intensity)
            };
            let range = if hi > lo { hi - lo } else { 1.0 };
            for i in 0..n {
                let v = channel.get(i).copied().unwrap_or(0.0);
                let mut t = ((v - lo) / range).clamp(0.0, 1.0);
                if opts.invert_rainbow {
                    t = 1.0 - t;
                }
                let c = if opts.use_rainbow {
                    rainbow(t)
                } else {
                    lerp_color(opts.min_color, opts.max_color, t)
                };
                colors.extend_from_slice(&c);
            }
        }
        Transformer::Rgb8 => {
            let rgb = pts.rgb.as_deref().unwrap_or(&[]);
            for i in 0..n {
                let v = rgb.get(i).copied().unwrap_or(0);
                colors.extend_from_slice(&[
                    ((v >> 16) & 0xff) as u8,
                    ((v >> 8) & 0xff) as u8,
                    (v & 0xff) as u8,
                ]);
            }
        }
        Transformer::RgbF32 => {
            let (r, g, b) = (
                pts.channel("r").unwrap_or(&[]),
                pts.channel("g").unwrap_or(&[]),
                pts.channel("b").unwrap_or(&[]),
            );
            let to8 = |c: &[f32], i: usize| {
                (c.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0) * 255.0) as u8
            };
            for i in 0..n {
                colors.extend_from_slice(&[to8(r, i), to8(g, i), to8(b, i)]);
            }
        }
    }
    CloudOutput {
        positions,
        colors,
        count: n,
        transformer,
        min: lo,
        max: hi,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::quat_from_yaw;
    use crate::msgs::common::Header;

    fn pts(xyz: &[f32], intensity: Option<&[f32]>) -> Points {
        let mut p = Points {
            xyz: xyz.to_vec(),
            ..Default::default()
        };
        if let Some(i) = intensity {
            p.channels.push((String::from("intensity"), i.to_vec()));
        }
        p
    }

    #[test]
    fn rainbow_endpoints() {
        // rviz getRainbowColor: 0 → magenta, 0.2 → blue, 0.6 → green, 1 → red
        assert_eq!(rainbow(0.0), [255, 0, 255]);
        assert_eq!(rainbow(0.2), [0, 0, 255]);
        assert_eq!(rainbow(0.6), [0, 255, 0]);
        assert_eq!(rainbow(1.0), [255, 0, 0]);
    }

    #[test]
    fn intensity_autocompute_and_fixed_bounds() {
        let p = pts(&[0.0; 9], Some(&[0.0, 50.0, 100.0]));
        let out = build_cloud(&p, &Transform::IDENTITY, &ColorOptions::default());
        assert_eq!(out.transformer, Transformer::Intensity);
        assert_eq!((out.min, out.max), (0.0, 100.0));
        assert_eq!(&out.colors[0..3], &[255, 0, 255]);
        assert_eq!(&out.colors[6..9], &[255, 0, 0]);
        let opts = ColorOptions {
            intensity_autocompute: false,
            min_intensity: 0.0,
            max_intensity: 1000.0,
            use_rainbow: false,
            ..Default::default()
        };
        let out = build_cloud(&p, &Transform::IDENTITY, &opts);
        assert_eq!(&out.colors[3..6], &[12, 12, 12]); // 50/1000 of black→white
        let opts = ColorOptions {
            invert_rainbow: true,
            ..Default::default()
        };
        let out = build_cloud(&p, &Transform::IDENTITY, &opts);
        assert_eq!(&out.colors[0..3], &[255, 0, 0]);
    }

    #[test]
    fn axis_color_uses_fixed_frame_or_message_frame() {
        let p = pts(&[0.0, 0.0, 0.0, 0.0, 0.0, 1.0], None);
        let tf = Transform::new([0.0, 0.0, 5.0], [0.0, 0.0, 0.0, 1.0]);
        let opts = ColorOptions {
            transformer: Transformer::AxisColor,
            axis: 2,
            ..Default::default()
        };
        let out = build_cloud(&p, &tf, &opts);
        assert_eq!((out.min, out.max), (5.0, 6.0));
        assert_eq!(out.positions[5], 6.0);
        let opts = ColorOptions {
            axis_use_fixed_frame: false,
            ..opts
        };
        let out = build_cloud(&p, &tf, &opts);
        assert_eq!((out.min, out.max), (0.0, 1.0));
    }

    #[test]
    fn falls_back_when_transformer_unsupported() {
        let p = pts(&[0.0; 3], None); // no channels → Intensity unsupported
        let out = build_cloud(&p, &Transform::IDENTITY, &ColorOptions::default());
        assert_eq!(out.transformer, Transformer::AxisColor);
        let mut rgb = pts(&[0.0; 3], None);
        rgb.rgb = Some(vec![0x00ff8000]);
        let out = build_cloud(&rgb, &Transform::IDENTITY, &ColorOptions::default());
        assert_eq!(out.transformer, Transformer::Rgb8);
        assert_eq!(out.colors, vec![255, 128, 0]);
    }

    #[test]
    fn flat_color_and_transform() {
        let p = pts(&[1.0, 0.0, 0.0], None);
        let tf = Transform::new([0.0, 0.0, 0.0], quat_from_yaw(core::f64::consts::FRAC_PI_2));
        let opts = ColorOptions {
            transformer: Transformer::FlatColor,
            flat_color: [1, 2, 3],
            ..Default::default()
        };
        let out = build_cloud(&p, &tf, &opts);
        assert!((out.positions[1] - 1.0).abs() < 1e-6);
        assert_eq!(out.colors, vec![1, 2, 3]);
    }

    #[test]
    fn laser_scan_projection_drops_invalid() {
        let s = LaserScan {
            header: Header::default(),
            angle_min: 0.0,
            angle_max: 1.0,
            angle_increment: core::f32::consts::FRAC_PI_2,
            time_increment: 0.0,
            scan_time: 0.0,
            range_min: 0.1,
            range_max: 10.0,
            ranges: vec![1.0, 2.0, f32::INFINITY, 0.05],
            intensities: vec![10.0, 20.0, 30.0, 40.0],
        };
        let p = points_from_laser_scan(&s);
        assert_eq!(p.len(), 2);
        assert!((p.xyz[0] - 1.0).abs() < 1e-6);
        assert!((p.xyz[4] - 2.0).abs() < 1e-6); // second point along +Y
        assert_eq!(p.channel("intensity").unwrap(), &[10.0, 20.0]);
    }
}
