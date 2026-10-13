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
    /// Wall-ish time (as given by the caller) at which this frame's newest
    /// stamp last changed, for Frame Timeout. Re-sending the same stamp does
    /// not count as an update (rviz2 watches the latest common time, not the
    /// message rate).
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
    /// Frame Timeout bookkeeping; it is recorded only when the frame's newest
    /// stamp changes. Non-finite transforms are rejected.
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
        if is_static {
            f.is_static = true;
            f.last_update_ns = now_ns;
            f.history.clear();
            f.history.push_back((stamp_ns, tf));
            return true;
        }
        f.is_static = false;
        if f.history.back().is_none_or(|(t, _)| *t != stamp_ns) {
            f.last_update_ns = now_ns;
        }
        // A sample older than the whole cache window means the publisher's clock
        // was reset (e.g. a sim restarted at t=0). tf2 would drop it as
        // TF_OLD_DATA and rviz2 clears its buffer on a clock jump; a viewer is
        // better off following the new clock, so start this frame's history over.
        if f.history
            .back()
            .is_some_and(|(t, _)| *t > stamp_ns.saturating_add(self.cache_ns))
        {
            f.history.clear();
        }
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
        let (src_chain, common, tgt_chain) = self.chains(target, source)?;

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

    /// The frames on both paths from `target` and `source` up to their common
    /// ancestor: `(source chain root-wards, index of the common ancestor in
    /// it, target chain root-wards excluding the ancestor)`.
    #[allow(clippy::type_complexity)]
    fn chains(
        &self,
        target: &str,
        source: &str,
    ) -> Result<(Vec<usize>, usize, Vec<usize>), TfError> {
        let ti = *self.index.get(target).ok_or(TfError::UnknownFrame)?;
        let si = *self.index.get(source).ok_or(TfError::UnknownFrame)?;

        // Walk source up to the root.
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
        Ok((src_chain, common, tgt_chain))
    }

    /// When the transform `target`←`source` last changed, as the oldest
    /// `last_update_ns` of the dynamic frames on the path between them (rviz2's
    /// TF display ages a frame from the moment its latest common time with the
    /// Fixed Frame stopped moving, so a stale link anywhere on the path ages
    /// the whole subtree). `Ok(None)` means every link is static (tf2 reports
    /// `TimePointZero`): such a frame never times out.
    pub fn last_update_to(&self, target: &str, source: &str) -> Result<Option<TimeNs>, TfError> {
        let target = strip_slash(target);
        let source = strip_slash(source);
        if target == source {
            return Ok(None);
        }
        let (src_chain, common, tgt_chain) = self.chains(target, source)?;
        Ok(src_chain[..common]
            .iter()
            .chain(tgt_chain.iter())
            .map(|&i| &self.frames[i])
            .filter(|f| !f.is_static)
            .map(|f| f.last_update_ns)
            .min())
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
    fn restarted_clock_replaces_stale_history() {
        let mut b = TfBuffer::default(); // 10 s cache
        let at = |x: f64| Transform::new([x, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]);
        b.insert("map", "base", 100_000_000_000, at(1.0), false, 0);
        b.insert("map", "base", 300_000_000_000, at(2.0), false, 0);
        // Out of order but within the cache: goes in place, latest unchanged.
        b.insert("map", "base", 295_000_000_000, at(1.5), false, 0);
        assert_eq!(b.latest_stamp("base"), Some(300_000_000_000));
        assert!(close(
            b.lookup("map", "base", 0).unwrap().t,
            [2.0, 0.0, 0.0]
        ));
        // The publisher restarted at t=0: the old run must not stay "latest".
        b.insert("map", "base", 50_000_000, at(0.0), false, 0);
        assert_eq!(b.latest_stamp("base"), Some(50_000_000));
        assert!(close(
            b.lookup("map", "base", 0).unwrap().t,
            [0.0, 0.0, 0.0]
        ));
        b.insert("map", "base", 100_000_000, at(0.1), false, 0);
        assert!(close(
            b.lookup("map", "base", 75_000_000).unwrap().t,
            [0.05, 0.0, 0.0]
        ));
        assert_eq!(
            b.lookup("map", "base", 300_000_000_000),
            Err(TfError::Extrapolation)
        );
    }

    #[test]
    fn last_update_only_moves_with_new_stamps() {
        let mut b = TfBuffer::default();
        b.insert("map", "base", 1_000, Transform::IDENTITY, false, 10);
        assert_eq!(b.last_update_ns("base"), Some(10));
        // Same stamp again later: a publisher repeating itself is not an update.
        b.insert("map", "base", 1_000, Transform::IDENTITY, false, 20);
        assert_eq!(b.last_update_ns("base"), Some(10));
        b.insert("map", "base", 2_000, Transform::IDENTITY, false, 30);
        assert_eq!(b.last_update_ns("base"), Some(30));
        // A restarted clock (sample older than the cache) is a change too.
        b.insert("map", "base", 2_000, Transform::IDENTITY, false, 40);
        assert_eq!(b.last_update_ns("base"), Some(30));
        b.insert("map", "base", 1, Transform::IDENTITY, false, 50);
        assert_eq!(b.last_update_ns("base"), Some(50));
    }

    #[test]
    fn chain_last_update_is_min_over_dynamic_links() {
        let mut b = TfBuffer::default();
        b.insert("map", "odom", 0, Transform::IDENTITY, true, 900);
        b.insert("odom", "base", 1_000, Transform::IDENTITY, false, 100);
        b.insert("base", "livox", 0, Transform::IDENTITY, true, 500);
        b.insert("odom", "other", 1_000, Transform::IDENTITY, false, 300);
        b.insert("world", "robot", 1_000, Transform::IDENTITY, false, 1);
        // The static child ages with its dynamic parent.
        assert_eq!(b.last_update_to("map", "livox"), Ok(Some(100)));
        assert_eq!(b.last_update_to("livox", "map"), Ok(Some(100)));
        // Both sides of the common ancestor count.
        assert_eq!(b.last_update_to("other", "livox"), Ok(Some(100)));
        // All-static path: never times out.
        assert_eq!(b.last_update_to("map", "odom"), Ok(None));
        assert_eq!(b.last_update_to("map", "map"), Ok(None));
        assert_eq!(b.last_update_to("map", "robot"), Err(TfError::NotConnected));
        assert_eq!(b.last_update_to("map", "nope"), Err(TfError::UnknownFrame));
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
