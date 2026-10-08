//! Covariance visuals (rviz_default_plugins CovarianceVisual): the position
//! ellipsoid from the 3×3 position block of a 6×6 pose covariance, and the
//! orientation uncertainty as three discs (3-D) or a yaw sector (2-D).
//!
//! Everything here returns ready-to-draw scales/orientations so the main
//! thread never touches the matrix (spec §3 thread rule).

#![allow(clippy::needless_range_loop)]

use crate::math::quat_normalize;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
#[cfg(not(feature = "std"))]
use libm::{atan2, sqrt};
#[cfg(feature = "std")]
fn sqrt(x: f64) -> f64 {
    x.sqrt()
}
#[cfg(feature = "std")]
fn atan2(y: f64, x: f64) -> f64 {
    y.atan2(x)
}

/// Eigen-decomposition of a symmetric 3×3 matrix (cyclic Jacobi).
/// Returns eigenvalues (descending) and the matching unit eigenvectors as
/// columns of a right-handed basis.
pub fn eigen_symmetric3(m: &[[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut a = *m;
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _sweep in 0..50 {
        let off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
        if off < 1e-30 {
            break;
        }
        for (p, q) in [(0usize, 1usize), (0, 2), (1, 2)] {
            if a[p][q].abs() < 1e-300 {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            let t = theta.signum() / (theta.abs() + sqrt(theta * theta + 1.0));
            let t = if theta == 0.0 { 1.0 } else { t };
            let c = 1.0 / sqrt(t * t + 1.0);
            let s = t * c;
            for k in 0..3 {
                let akp = a[k][p];
                let akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let apk = a[p][k];
                let aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for k in 0..3 {
                let vkp = v[k][p];
                let vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    // Sort descending, keeping columns with their values.
    let mut idx = [0usize, 1, 2];
    let vals = [a[0][0], a[1][1], a[2][2]];
    idx.sort_by(|&i, &j| {
        vals[j]
            .partial_cmp(&vals[i])
            .unwrap_or(core::cmp::Ordering::Equal)
    });
    let values = [vals[idx[0]], vals[idx[1]], vals[idx[2]]];
    let mut vectors = [[0.0; 3]; 3];
    for (c, &i) in idx.iter().enumerate() {
        for r in 0..3 {
            vectors[r][c] = v[r][i];
        }
    }
    // Right-handed: flip the last column if the determinant is negative.
    let det = vectors[0][0] * (vectors[1][1] * vectors[2][2] - vectors[1][2] * vectors[2][1])
        - vectors[0][1] * (vectors[1][0] * vectors[2][2] - vectors[1][2] * vectors[2][0])
        + vectors[0][2] * (vectors[1][0] * vectors[2][1] - vectors[1][1] * vectors[2][0]);
    if det < 0.0 {
        for r in 0..3 {
            vectors[r][2] = -vectors[r][2];
        }
    }
    (values, vectors)
}

/// Eigen-decomposition of a symmetric 2×2 matrix `[[a, b], [b, d]]`:
/// eigenvalues (descending) and the angle of the first eigenvector.
pub fn eigen_symmetric2(a: f64, b: f64, d: f64) -> ([f64; 2], f64) {
    let tr = a + d;
    let det = a * d - b * b;
    let disc = sqrt((tr * tr / 4.0 - det).max(0.0));
    let l1 = tr / 2.0 + disc;
    let l2 = tr / 2.0 - disc;
    let angle = if b.abs() < 1e-300 {
        if a >= d {
            0.0
        } else {
            core::f64::consts::FRAC_PI_2
        }
    } else {
        atan2(l1 - a, b)
    };
    ([l1, l2], angle)
}

/// Quaternion `[x, y, z, w]` of a rotation matrix given as columns.
pub fn quat_from_columns(m: &[[f64; 3]; 3]) -> [f64; 4] {
    // m[r][c]
    let tr = m[0][0] + m[1][1] + m[2][2];
    let q = if tr > 0.0 {
        let s = sqrt(tr + 1.0) * 2.0;
        [
            (m[2][1] - m[1][2]) / s,
            (m[0][2] - m[2][0]) / s,
            (m[1][0] - m[0][1]) / s,
            0.25 * s,
        ]
    } else if m[0][0] > m[1][1] && m[0][0] > m[2][2] {
        let s = sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2.0;
        [
            0.25 * s,
            (m[0][1] + m[1][0]) / s,
            (m[0][2] + m[2][0]) / s,
            (m[2][1] - m[1][2]) / s,
        ]
    } else if m[1][1] > m[2][2] {
        let s = sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2.0;
        [
            (m[0][1] + m[1][0]) / s,
            0.25 * s,
            (m[1][2] + m[2][1]) / s,
            (m[0][2] - m[2][0]) / s,
        ]
    } else {
        let s = sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2.0;
        [
            (m[0][2] + m[2][0]) / s,
            (m[1][2] + m[2][1]) / s,
            0.25 * s,
            (m[1][0] - m[0][1]) / s,
        ]
    };
    quat_normalize(q)
}

/// Position ellipsoid: half axes `scale · σ` along the eigenvectors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ellipsoid {
    pub half_axes: [f64; 3],
    pub quat: [f64; 4],
}

pub fn position_ellipsoid(cov: &[f64; 36], scale: f64) -> Option<Ellipsoid> {
    let m = [
        [cov[0], cov[1], cov[2]],
        [cov[6], cov[7], cov[8]],
        [cov[12], cov[13], cov[14]],
    ];
    if m.iter().flatten().any(|v| !v.is_finite()) {
        return None;
    }
    let (vals, vecs) = eigen_symmetric3(&m);
    if vals.iter().all(|v| *v <= 0.0) {
        return None;
    }
    let half_axes = [
        scale * sqrt(vals[0].max(0.0)),
        scale * sqrt(vals[1].max(0.0)),
        scale * sqrt(vals[2].max(0.0)),
    ];
    Some(Ellipsoid {
        half_axes,
        quat: quat_from_columns(&vecs),
    })
}

/// rviz: a pose is "2-D" when the z, roll and pitch variances are all zero.
pub fn is_2d(cov: &[f64; 36]) -> bool {
    cov[14] <= 0.0 && cov[21] <= 0.0 && cov[28] <= 0.0
}

/// One orientation disc: perpendicular to `axis` (0 = x, 1 = y, 2 = z), at
/// `offset` along it, with in-plane half axes and the in-plane angle of the
/// first axis (measured in the disc's plane from its first basis vector).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrientationDisc {
    pub axis: usize,
    pub half_axes: [f64; 2],
    pub angle: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OrientationVisual {
    /// 3-D: discs for roll (x), pitch (y) and yaw (z).
    Discs([OrientationDisc; 3]),
    /// 2-D: a sector in the XY plane of half-angle `half_angle` (rad) and radius `offset`.
    Yaw2D { half_angle: f64 },
}

/// Orientation uncertainty from the 3×3 rotation block (rows/cols 3..6 =
/// roll, pitch, yaw). Each disc shows the two rotation components other than
/// its own axis: a point `offset` along the axis moves by `offset · σ`.
pub fn orientation_visual(cov: &[f64; 36], scale: f64, offset: f64) -> Option<OrientationVisual> {
    let r = |i: usize, j: usize| cov[(3 + i) * 6 + 3 + j];
    for i in 0..3 {
        for j in 0..3 {
            if !r(i, j).is_finite() {
                return None;
            }
        }
    }
    if is_2d(cov) {
        let yaw_var = r(2, 2);
        if yaw_var <= 0.0 {
            return None;
        }
        return Some(OrientationVisual::Yaw2D {
            half_angle: scale * sqrt(yaw_var),
        });
    }
    let mut discs = [OrientationDisc {
        axis: 0,
        half_axes: [0.0; 2],
        angle: 0.0,
    }; 3];
    for (axis, disc) in discs.iter_mut().enumerate() {
        // The two other rotation components, in cyclic order (y,z), (z,x), (x,y).
        let (a, b) = ((axis + 1) % 3, (axis + 2) % 3);
        let (vals, angle) = eigen_symmetric2(r(a, a), r(a, b), r(b, b));
        *disc = OrientationDisc {
            axis,
            half_axes: [
                scale * offset * sqrt(vals[0].max(0.0)),
                scale * offset * sqrt(vals[1].max(0.0)),
            ],
            angle,
        };
    }
    Some(OrientationVisual::Discs(discs))
}

/// Flattens an orientation visual for the wire: 3-D → 3 × [axis, a, b, angle], 2-D → [half_angle].
pub fn orientation_to_vec(v: &OrientationVisual) -> Vec<f32> {
    match v {
        OrientationVisual::Discs(d) => d
            .iter()
            .flat_map(|x| {
                [
                    x.axis as f32,
                    x.half_axes[0] as f32,
                    x.half_axes[1] as f32,
                    x.angle as f32,
                ]
            })
            .collect(),
        OrientationVisual::Yaw2D { half_angle } => [*half_angle as f32].into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::quat_rotate;

    fn cov_with(pos: [[f64; 3]; 3], rot: [f64; 3]) -> [f64; 36] {
        let mut c = [0.0; 36];
        for i in 0..3 {
            for j in 0..3 {
                c[i * 6 + j] = pos[i][j];
            }
            c[(3 + i) * 6 + 3 + i] = rot[i];
        }
        c
    }

    #[test]
    fn eigen_diagonal_sorted() {
        let (vals, vecs) = eigen_symmetric3(&[[1.0, 0.0, 0.0], [0.0, 9.0, 0.0], [0.0, 0.0, 4.0]]);
        assert_eq!(vals, [9.0, 4.0, 1.0]);
        // first eigenvector is ±y
        assert!((vecs[1][0].abs() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn eigen_rotated_45_degrees() {
        // 2x2 block rotated by 45°: eigenvalues 3 and 1 with vectors (1,1)/√2, (1,-1)/√2
        let (vals, vecs) = eigen_symmetric3(&[[2.0, 1.0, 0.0], [1.0, 2.0, 0.0], [0.0, 0.0, 0.5]]);
        assert!(
            (vals[0] - 3.0).abs() < 1e-9
                && (vals[1] - 1.0).abs() < 1e-9
                && (vals[2] - 0.5).abs() < 1e-9
        );
        assert!((vecs[0][0].abs() - core::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9);
        assert!((vecs[1][0] / vecs[0][0] - 1.0).abs() < 1e-9);
        // quaternion rotates +x onto the first eigenvector
        let q = quat_from_columns(&vecs);
        let x = quat_rotate(q, [1.0, 0.0, 0.0]);
        assert!((x[0] - vecs[0][0]).abs() < 1e-9 && (x[1] - vecs[1][0]).abs() < 1e-9);
    }

    #[test]
    fn ellipsoid_half_axes_are_scaled_sigmas() {
        let cov = cov_with(
            [[0.04, 0.0, 0.0], [0.0, 0.01, 0.0], [0.0, 0.0, 0.0001]],
            [0.0, 0.0, 0.0],
        );
        let e = position_ellipsoid(&cov, 2.0).unwrap();
        assert!((e.half_axes[0] - 0.4).abs() < 1e-12);
        assert!((e.half_axes[1] - 0.2).abs() < 1e-12);
        assert!((e.half_axes[2] - 0.02).abs() < 1e-12);
    }

    #[test]
    fn zero_and_nan_covariance_give_nothing() {
        let zero = [0.0; 36];
        assert!(position_ellipsoid(&zero, 1.0).is_none());
        assert!(orientation_visual(&zero, 1.0, 1.0).is_none());
        let mut nan = zero;
        nan[0] = f64::NAN;
        assert!(position_ellipsoid(&nan, 1.0).is_none());
    }

    #[test]
    fn two_d_detection_and_yaw_sector() {
        let cov = cov_with(
            [[0.1, 0.0, 0.0], [0.0, 0.1, 0.0], [0.0, 0.0, 0.0]],
            [0.0, 0.0, 0.09],
        );
        assert!(is_2d(&cov));
        match orientation_visual(&cov, 1.0, 1.0).unwrap() {
            OrientationVisual::Yaw2D { half_angle } => assert!((half_angle - 0.3).abs() < 1e-12),
            _ => panic!("expected 2-D"),
        }
        let cov3 = cov_with(
            [[0.1, 0.0, 0.0], [0.0, 0.1, 0.0], [0.0, 0.0, 0.1]],
            [0.01, 0.04, 0.09],
        );
        assert!(!is_2d(&cov3));
        match orientation_visual(&cov3, 1.0, 2.0).unwrap() {
            OrientationVisual::Discs(d) => {
                // x disc shows pitch (0.2) and yaw (0.3), times offset 2
                assert_eq!(d[0].axis, 0);
                assert!(
                    (d[0].half_axes[0] - 0.6).abs() < 1e-9
                        && (d[0].half_axes[1] - 0.4).abs() < 1e-9
                );
                assert_eq!(orientation_to_vec(&OrientationVisual::Discs(d)).len(), 12);
            }
            _ => panic!("expected 3-D"),
        }
    }
}
