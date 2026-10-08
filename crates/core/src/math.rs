//! Minimal rigid-transform math (f64) used by the tf buffer and message
//! transforms. Quaternions are `[x, y, z, w]`. Uses `libm` so the crate stays
//! `no_std`-clean.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    pub t: [f64; 3],
    pub q: [f64; 4],
}

impl Transform {
    pub const IDENTITY: Transform = Transform {
        t: [0.0; 3],
        q: [0.0, 0.0, 0.0, 1.0],
    };

    pub fn new(t: [f64; 3], q: [f64; 4]) -> Self {
        Self { t, q }
    }

    pub fn is_finite(&self) -> bool {
        self.t.iter().chain(self.q.iter()).all(|v| v.is_finite())
    }

    /// `self * other`: apply `other` first, then `self`.
    pub fn mul(&self, other: &Transform) -> Transform {
        Transform {
            t: self.apply_point(other.t),
            q: quat_mul(self.q, other.q),
        }
    }

    pub fn inverse(&self) -> Transform {
        let qi = quat_conj(self.q);
        let t = quat_rotate(qi, self.t);
        Transform {
            t: [-t[0], -t[1], -t[2]],
            q: qi,
        }
    }

    pub fn apply_point(&self, p: [f64; 3]) -> [f64; 3] {
        let r = quat_rotate(self.q, p);
        [r[0] + self.t[0], r[1] + self.t[1], r[2] + self.t[2]]
    }

    pub fn apply_vector(&self, v: [f64; 3]) -> [f64; 3] {
        quat_rotate(self.q, v)
    }

    /// Linear translation + slerp rotation, `s` in 0..=1.
    pub fn interpolate(&self, other: &Transform, s: f64) -> Transform {
        Transform {
            t: [
                self.t[0] + (other.t[0] - self.t[0]) * s,
                self.t[1] + (other.t[1] - self.t[1]) * s,
                self.t[2] + (other.t[2] - self.t[2]) * s,
            ],
            q: quat_slerp(self.q, other.q, s),
        }
    }
}

pub fn quat_normalize(q: [f64; 4]) -> [f64; 4] {
    let n = libm::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if n == 0.0 || !n.is_finite() {
        return [0.0, 0.0, 0.0, 1.0];
    }
    [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

pub fn quat_conj(q: [f64; 4]) -> [f64; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

pub fn quat_mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let (ax, ay, az, aw) = (a[0], a[1], a[2], a[3]);
    let (bx, by, bz, bw) = (b[0], b[1], b[2], b[3]);
    [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]
}

pub fn quat_rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    let (qx, qy, qz, qw) = (q[0], q[1], q[2], q[3]);
    let c1 = [
        qy * v[2] - qz * v[1] + qw * v[0],
        qz * v[0] - qx * v[2] + qw * v[1],
        qx * v[1] - qy * v[0] + qw * v[2],
    ];
    let c2 = [
        qy * c1[2] - qz * c1[1],
        qz * c1[0] - qx * c1[2],
        qx * c1[1] - qy * c1[0],
    ];
    [v[0] + 2.0 * c2[0], v[1] + 2.0 * c2[1], v[2] + 2.0 * c2[2]]
}

pub fn quat_slerp(a: [f64; 4], b: [f64; 4], s: f64) -> [f64; 4] {
    let mut dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let mut b = b;
    if dot < 0.0 {
        dot = -dot;
        b = [-b[0], -b[1], -b[2], -b[3]];
    }
    if dot > 0.9995 {
        return quat_normalize([
            a[0] + (b[0] - a[0]) * s,
            a[1] + (b[1] - a[1]) * s,
            a[2] + (b[2] - a[2]) * s,
            a[3] + (b[3] - a[3]) * s,
        ]);
    }
    let theta0 = libm::acos(dot.clamp(-1.0, 1.0));
    let theta = theta0 * s;
    let sin0 = libm::sin(theta0);
    let wa = libm::sin((1.0 - s) * theta0) / sin0;
    let wb = libm::sin(theta) / sin0;
    [
        a[0] * wa + b[0] * wb,
        a[1] * wa + b[1] * wb,
        a[2] * wa + b[2] * wb,
        a[3] * wa + b[3] * wb,
    ]
}

/// Quaternion for a rotation of `yaw` radians about +Z.
pub fn quat_from_yaw(yaw: f64) -> [f64; 4] {
    [0.0, 0.0, libm::sin(yaw / 2.0), libm::cos(yaw / 2.0)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [f64; 3], b: [f64; 3]) -> bool {
        a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn rotate_and_inverse() {
        let t = Transform::new([1.0, 2.0, 3.0], quat_from_yaw(core::f64::consts::FRAC_PI_2));
        let p = t.apply_point([1.0, 0.0, 0.0]);
        assert!(close(p, [1.0, 3.0, 3.0]), "{p:?}");
        let back = t.inverse().apply_point(p);
        assert!(close(back, [1.0, 0.0, 0.0]));
        let id = t.mul(&t.inverse());
        assert!(close(id.t, [0.0; 3]));
        assert!((id.q[3].abs() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn chain_composition_order() {
        let a = Transform::new([1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]);
        let b = Transform::new([0.0, 0.0, 0.0], quat_from_yaw(core::f64::consts::FRAC_PI_2));
        // a * b: rotate first, then translate.
        let p = a.mul(&b).apply_point([1.0, 0.0, 0.0]);
        assert!(close(p, [1.0, 1.0, 0.0]), "{p:?}");
    }

    #[test]
    fn interpolation_midpoint() {
        let a = Transform::IDENTITY;
        let b = Transform::new([2.0, 0.0, 0.0], quat_from_yaw(1.0));
        let m = a.interpolate(&b, 0.5);
        assert!(close(m.t, [1.0, 0.0, 0.0]));
        let yaw = 2.0 * m.q[2].atan2(m.q[3]);
        assert!((yaw - 0.5).abs() < 1e-9, "{yaw}");
    }
}
