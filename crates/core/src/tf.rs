//! Client-side tf2 buffer (spec §7.5): a tree of frames with time-stamped
//! child→parent transforms, interpolated lookups, static transforms, and a
//! bounded history. Lives in the Web Worker (via WASM); the main thread only
//! sees snapshots.

use crate::math::{Transform, quat_normalize};
#[cfg(not(feature = "std"))]
use alloc::{collections::VecDeque, string::String, vec::Vec};
#[cfg(feature = "std")]
use std::collections::VecDeque;

#[cfg(not(feature = "std"))]
use alloc::collections::BTreeMap as Map;
#[cfg(feature = "std")]
use std::collections::BTreeMap as Map;

/// Nanoseconds; 0 means "latest".
pub type TimeNs = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TfError {
    UnknownFrame,
    /// Frames exist but are not connected.
    NotConnected,
    /// Requested time is outside the stored history (and extrapolation is off).
    Extrapolation,
}

#[derive(Debug, Clone)]
struct Frame {
    name: String,
    parent: Option<usize>,
    /// child→parent samples, oldest first.
    history: VecDeque<(TimeNs, Transform)>,
    is_static: bool,
    /// Wall-ish time (as given by the caller) of the last update, for Frame Timeout.
    last_update_ns: TimeNs,
}

pub struct TfBuffer {
    frames: Vec<Frame>,
    index: Map<String, usize>,
    cache_ns: u64,
}

impl Default for TfBuffer {
    fn default() -> Self {
        Self::new(10_000_000_000)
    }
}

impl TfBuffer {
    pub fn new(cache_ns: u64) -> Self {
        Self {
            frames: Vec::new(),
            index: Map::new(),
            cache_ns,
        }
    }

    pub fn clear(&mut self) {
        self.frames.clear();
        self.index.clear();
    }

    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    pub fn frame_names(&self) -> impl Iterator<Item = &str> {
        self.frames.iter().map(|f| f.name.as_str())
    }

    pub fn frame_index(&self, name: &str) -> Option<usize> {
        self.index.get(name).copied()
    }

    pub fn frame_name(&self, idx: usize) -> Option<&str> {
        self.frames.get(idx).map(|f| f.name.as_str())
    }

    pub fn parent_of(&self, name: &str) -> Option<&str> {
        let f = &self.frames[*self.index.get(name)?];
        f.parent.map(|p| self.frames[p].name.as_str())
    }

    pub fn last_update_ns(&self, name: &str) -> Option<TimeNs> {
        self.index.get(name).map(|&i| self.frames[i].last_update_ns)
    }

    pub fn is_static(&self, name: &str) -> Option<bool> {
        self.index.get(name).map(|&i| self.frames[i].is_static)
    }

    fn intern(&mut self, name: &str) -> usize {
        if let Some(&i) = self.index.get(name) {
            return i;
        }
        let i = self.frames.len();
        self.frames.push(Frame {
            name: String::from(name),
            parent: None,
            history: VecDeque::new(),
            is_static: false,
            last_update_ns: 0,
        });
        self.index.insert(String::from(name), i);
        i
    }

    /// Inserts a child→parent transform. `now_ns` is the receive time used for
    /// Frame Timeout bookkeeping. Non-finite transforms are rejected.
    pub fn insert(
        &mut self,
        parent: &str,
        child: &str,
        stamp_ns: TimeNs,
        tf: Transform,
        is_static: bool,
        now_ns: TimeNs,
    ) -> bool {
        if !tf.is_finite() || parent == child || parent.is_empty() || child.is_empty() {
            return false;
        }
        let tf = Transform {
            t: tf.t,
            q: quat_normalize(tf.q),
        };
        let p = self.intern(strip_slash(parent));
        let c = self.intern(strip_slash(child));
        let f = &mut self.frames[c];
        f.parent = Some(p);
        f.last_update_ns = now_ns;
        if is_static {
            f.is_static = true;
            f.history.clear();
            f.history.push_back((stamp_ns, tf));
            return true;
        }
        f.is_static = false;
        // Keep history sorted by stamp; out-of-order samples go in place.
        match f.history.back() {
            Some((t, _)) if *t <= stamp_ns => f.history.push_back((stamp_ns, tf)),
            _ => {
                let pos = f.history.partition_point(|(t, _)| *t < stamp_ns);
                f.history.insert(pos, (stamp_ns, tf));
            }
        }
        let cutoff = stamp_ns.saturating_sub(self.cache_ns);
        while f.history.len() > 1 && f.history.front().is_some_and(|(t, _)| *t < cutoff) {
            f.history.pop_front();
        }
        true
    }

    /// Latest stamp stored for `name` (static frames report `u64::MAX`-free 0).
    pub fn latest_stamp(&self, name: &str) -> Option<TimeNs> {
        let f = &self.frames[*self.index.get(name)?];
        f.history.back().map(|(t, _)| *t)
    }

    /// child→parent transform of frame `idx` at `time` (0 = latest).
    fn sample(&self, idx: usize, time: TimeNs) -> Result<Transform, TfError> {
        let f = &self.frames[idx];
        let h = &f.history;
        let (Some(first), Some(last)) = (h.front(), h.back()) else {
            return Err(TfError::NotConnected);
        };
        if f.is_static || time == 0 || h.len() == 1 {
            return Ok(last.1);
        }
        if time >= last.0 {
            // Like tf2 with a small tolerance: allow using the newest sample for
            // slightly future times, otherwise extrapolation error.
            return if time - last.0 <= EXTRAPOLATION_TOLERANCE_NS {
                Ok(last.1)
            } else {
                Err(TfError::Extrapolation)
            };
        }
        if time <= first.0 {
            return if first.0 - time <= EXTRAPOLATION_TOLERANCE_NS {
                Ok(first.1)
            } else {
                Err(TfError::Extrapolation)
            };
        }
        let i = h.partition_point(|(t, _)| *t <= time); // first sample with t > time
        let (t0, a) = h[i - 1];
        let (t1, b) = h[i];
        let s = (time - t0) as f64 / (t1 - t0) as f64;
        Ok(a.interpolate(&b, s))
    }

    /// Transform of `source` expressed in `target` (i.e. maps points from
    /// source to target), at `time` (0 = latest).
    pub fn lookup(&self, target: &str, source: &str, time: TimeNs) -> Result<Transform, TfError> {
        let target = strip_slash(target);
        let source = strip_slash(source);
        // Same frame is always identity, even when nothing has published that
        // frame yet (tf2 `BufferCore::lookupTransform` does the same). This is
        // what lets a sensor cloud render with the Fixed Frame set to its own
        // frame_id when the robot publishes no TF for it.
        if target == source {
            return Ok(Transform::IDENTITY);
        }
        let ti = *self.index.get(target).ok_or(TfError::UnknownFrame)?;
        let si = *self.index.get(source).ok_or(TfError::UnknownFrame)?;

        // Walk source up to the root, accumulating root←source.
        let mut src_chain: Vec<usize> = Vec::new();
        let mut i = si;
        loop {
            src_chain.push(i);
            match self.frames[i].parent {
                Some(p) if src_chain.len() < MAX_DEPTH => i = p,
                _ => break,
            }
        }
        // Walk target up until we hit a frame in the source chain (common ancestor).
        let mut tgt_chain: Vec<usize> = Vec::new();
        let mut i = ti;
        let common = loop {
            if let Some(pos) = src_chain.iter().position(|&f| f == i) {
                break pos;
            }
            tgt_chain.push(i);
            match self.frames[i].parent {
                Some(p) if tgt_chain.len() < MAX_DEPTH => i = p,
                _ => return Err(TfError::NotConnected),
            }
        };

        // common ← source
        let mut cs = Transform::IDENTITY;
        for &f in &src_chain[..common] {
            cs = self.sample(f, time)?.mul(&cs);
        }
        // common ← target
        let mut ct = Transform::IDENTITY;
        for &f in &tgt_chain {
            ct = self.sample(f, time)?.mul(&ct);
        }
        Ok(ct.inverse().mul(&cs))
    }

    pub fn can_transform(&self, target: &str, source: &str, time: TimeNs) -> bool {
        self.lookup(target, source, time).is_ok()
    }

    /// Message-filter policy used by the decoders: try the message stamp, then
    /// fall back to the latest transform. Returns the transform and whether the
    /// fallback was used.
    pub fn lookup_with_fallback(
        &self,
        target: &str,
        source: &str,
        time: TimeNs,
    ) -> Result<(Transform, bool), TfError> {
        match self.lookup(target, source, time) {
            Ok(t) => Ok((t, false)),
            Err(TfError::Extrapolation) => self.lookup(target, source, 0).map(|t| (t, true)),
            Err(e) => Err(e),
        }
    }
}

const MAX_DEPTH: usize = 256;
const EXTRAPOLATION_TOLERANCE_NS: u64 = 100_000_000; // 0.1 s, roughly tf2's default in practice

/// rviz FrameManager strips a leading '/' before tf lookups.
pub fn strip_slash(frame: &str) -> &str {
    frame.strip_prefix('/').unwrap_or(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::quat_from_yaw;

    fn close(a: [f64; 3], b: [f64; 3]) -> bool {
        a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn same_frame_is_identity_even_when_unknown() {
        // A sensor frame that no TF publisher mentions (e.g. a Livox cloud in
        // `robot01/laser` with the Fixed Frame set to the same name) must still
        // transform, exactly as tf2 does.
        let b = TfBuffer::default();
        assert_eq!(
            b.lookup("robot01/laser", "robot01/laser", 0),
            Ok(Transform::IDENTITY)
        );
        assert_eq!(
            b.lookup("/robot01/laser", "robot01/laser", 123),
            Ok(Transform::IDENTITY)
        );
        assert_eq!(
            b.lookup_with_fallback("robot01/laser", "robot01/laser", 0),
            Ok((Transform::IDENTITY, false))
        );
        // Distinct unknown frames still fail.
        assert_eq!(
            b.lookup("robot01/laser", "robot01/base_link", 0),
            Err(TfError::UnknownFrame)
        );
    }

    #[test]
    fn chain_lookup_and_inverse() {
        let mut b = TfBuffer::default();
        b.insert(
            "map",
            "odom",
            10,
            Transform::new([1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
            false,
            10,
        );
        b.insert(
            "odom",
            "base_link",
            10,
            Transform::new([0.0, 1.0, 0.0], quat_from_yaw(core::f64::consts::FRAC_PI_2)),
            false,
            10,
        );
        b.insert(
            "base_link",
            "laser",
            0,
            Transform::new([0.2, 0.0, 0.3], [0.0, 0.0, 0.0, 1.0]),
            true,
            10,
        );
        // laser origin in map: odom(1,0,0) + base(0,1,0) + rotate90(0.2,0,0.3) = (1, 1.2, 0.3)
        let t = b.lookup("map", "laser", 10).unwrap();
        assert!(close(t.t, [1.0, 1.2, 0.3]), "{:?}", t.t);
        let inv = b.lookup("laser", "map", 10).unwrap();
        assert!(close(inv.apply_point(t.t), [0.0; 3]));
        // sibling lookup through common ancestor
        b.insert(
            "base_link",
            "camera",
            0,
            Transform::new([0.0, 0.0, 1.0], [0.0, 0.0, 0.0, 1.0]),
            true,
            10,
        );
        let lc = b.lookup("laser", "camera", 10).unwrap();
        assert!(close(lc.t, [-0.2, 0.0, 0.7]), "{:?}", lc.t);
        assert_eq!(b.parent_of("laser"), Some("base_link"));
        assert_eq!(b.lookup("map", "nope", 0), Err(TfError::UnknownFrame));
    }

    #[test]
    fn interpolates_in_time_and_rejects_extrapolation() {
        let mut b = TfBuffer::default();
        b.insert(
            "map",
            "base",
            1_000_000_000,
            Transform::new([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
            false,
            0,
        );
        b.insert(
            "map",
            "base",
            3_000_000_000,
            Transform::new([2.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
            false,
            0,
        );
        let t = b.lookup("map", "base", 2_000_000_000).unwrap();
        assert!(close(t.t, [1.0, 0.0, 0.0]));
        assert!(close(
            b.lookup("map", "base", 0).unwrap().t,
            [2.0, 0.0, 0.0]
        ));
        assert_eq!(
            b.lookup("map", "base", 9_000_000_000),
            Err(TfError::Extrapolation)
        );
        assert!(b.lookup("map", "base", 3_050_000_000).is_ok()); // within tolerance
    }

    #[test]
    fn disconnected_trees_and_slashes() {
        let mut b = TfBuffer::default();
        b.insert("/map", "/odom", 1, Transform::IDENTITY, false, 1);
        b.insert("world", "robot", 1, Transform::IDENTITY, false, 1);
        assert_eq!(b.lookup("map", "robot", 0), Err(TfError::NotConnected));
        assert!(b.lookup("map", "/odom", 0).is_ok());
        assert!(b.frame_names().any(|n| n == "map"));
        assert!(!b.insert(
            "a",
            "b",
            1,
            Transform::new([f64::NAN, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
            false,
            1
        ));
    }

    #[test]
    fn history_is_bounded() {
        let mut b = TfBuffer::new(1_000);
        for i in 0..100u64 {
            b.insert("map", "base", i * 100, Transform::IDENTITY, false, 0);
        }
        let f = &b.frames[b.index["base"]];
        assert!(f.history.len() <= 12, "{}", f.history.len());
    }
}
