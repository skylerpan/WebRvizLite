//! Minimal CDR (XCDR1, as used by ROS 2 / DDS) reader and writer.
//!
//! Layout: 4-byte encapsulation header (`00 01 00 00` = CDR little-endian),
//! then the payload. Primitive alignment is relative to the **start of the
//! payload**, not the buffer. Strings are `u32 length (incl. NUL) + bytes + NUL`.
//! Sequences are `u32 count` followed by elements.

#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

const HEADER_LEN: usize = 4;
const CDR_LE: [u8; 4] = [0x00, 0x01, 0x00, 0x00];

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CdrError {
    #[error("message too short: need {need} bytes at offset {at}, have {have}")]
    Eof { at: usize, need: usize, have: usize },
    #[error("unsupported CDR encapsulation {0:#06x}")]
    Encapsulation(u16),
    #[error("string is not valid UTF-8")]
    Utf8,
    #[error("sequence length {0} exceeds remaining data")]
    SequenceTooLong(u32),
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// Little-endian CDR writer. Used by the mock transport and by tests that build
/// CDR fixtures; the server never serializes real messages.
#[derive(Debug, Clone)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Default for Writer {
    fn default() -> Self {
        Self::new()
    }
}

impl Writer {
    pub fn new() -> Self {
        let mut buf = Vec::with_capacity(256);
        buf.extend_from_slice(&CDR_LE);
        Self { buf }
    }

    pub fn with_capacity(payload_capacity: usize) -> Self {
        let mut buf = Vec::with_capacity(HEADER_LEN + payload_capacity);
        buf.extend_from_slice(&CDR_LE);
        Self { buf }
    }

    fn align(&mut self, n: usize) {
        let pos = self.buf.len() - HEADER_LEN;
        let pad = (n - pos % n) % n;
        self.buf.resize(self.buf.len() + pad, 0);
    }

    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }
    pub fn i8(&mut self, v: i8) -> &mut Self {
        self.u8(v as u8)
    }
    pub fn bool(&mut self, v: bool) -> &mut Self {
        self.u8(v as u8)
    }
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.align(2);
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn i16(&mut self, v: i16) -> &mut Self {
        self.u16(v as u16)
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.align(4);
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn i32(&mut self, v: i32) -> &mut Self {
        self.u32(v as u32)
    }
    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.align(8);
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn i64(&mut self, v: i64) -> &mut Self {
        self.u64(v as u64)
    }
    pub fn f32(&mut self, v: f32) -> &mut Self {
        self.u32(v.to_bits())
    }
    pub fn f64(&mut self, v: f64) -> &mut Self {
        self.u64(v.to_bits())
    }
    pub fn string(&mut self, s: &str) -> &mut Self {
        self.u32(s.len() as u32 + 1);
        self.buf.extend_from_slice(s.as_bytes());
        self.buf.push(0);
        self
    }
    /// Writes a sequence length prefix; the caller then writes `n` elements.
    pub fn seq_len(&mut self, n: usize) -> &mut Self {
        self.u32(n as u32)
    }
    pub fn f32_seq(&mut self, v: &[f32]) -> &mut Self {
        self.seq_len(v.len());
        for x in v {
            self.f32(*x);
        }
        self
    }
    /// Raw bytes with no alignment or length prefix (e.g. `uint8[]` payloads after `seq_len`).
    pub fn bytes(&mut self, b: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(b);
        self
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }
    pub fn is_empty(&self) -> bool {
        self.buf.len() == HEADER_LEN
    }
    pub fn finish(self) -> Vec<u8> {
        self.buf
    }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/// CDR reader over a borrowed message. Handles both endiannesses.
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    little_endian: bool,
}

impl<'a> Reader<'a> {
    /// Parses the encapsulation header. Only plain CDR (XCDR1) is accepted.
    pub fn new(data: &'a [u8]) -> Result<Self, CdrError> {
        if data.len() < HEADER_LEN {
            return Err(CdrError::Eof {
                at: 0,
                need: HEADER_LEN,
                have: data.len(),
            });
        }
        let kind = u16::from_be_bytes([data[0], data[1]]);
        let little_endian = match kind {
            0x0000 => false, // CDR_BE
            0x0001 => true,  // CDR_LE
            other => return Err(CdrError::Encapsulation(other)),
        };
        Ok(Self {
            data,
            pos: HEADER_LEN,
            little_endian,
        })
    }

    pub fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }
    pub fn position(&self) -> usize {
        self.pos
    }
    pub fn is_little_endian(&self) -> bool {
        self.little_endian
    }

    fn align(&mut self, n: usize) {
        let rel = self.pos - HEADER_LEN;
        self.pos += (n - rel % n) % n;
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], CdrError> {
        if self.remaining() < n {
            return Err(CdrError::Eof {
                at: self.pos,
                need: n,
                have: self.remaining(),
            });
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn u8(&mut self) -> Result<u8, CdrError> {
        Ok(self.take(1)?[0])
    }
    pub fn i8(&mut self) -> Result<i8, CdrError> {
        Ok(self.u8()? as i8)
    }
    pub fn bool(&mut self) -> Result<bool, CdrError> {
        Ok(self.u8()? != 0)
    }
    pub fn u16(&mut self) -> Result<u16, CdrError> {
        self.align(2);
        let b = self.take(2)?;
        let a = [b[0], b[1]];
        Ok(if self.little_endian {
            u16::from_le_bytes(a)
        } else {
            u16::from_be_bytes(a)
        })
    }
    pub fn i16(&mut self) -> Result<i16, CdrError> {
        Ok(self.u16()? as i16)
    }
    pub fn u32(&mut self) -> Result<u32, CdrError> {
        self.align(4);
        let b = self.take(4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Ok(if self.little_endian {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    }
    pub fn i32(&mut self) -> Result<i32, CdrError> {
        Ok(self.u32()? as i32)
    }
    pub fn u64(&mut self) -> Result<u64, CdrError> {
        self.align(8);
        let b = self.take(8)?;
        let a = [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]];
        Ok(if self.little_endian {
            u64::from_le_bytes(a)
        } else {
            u64::from_be_bytes(a)
        })
    }
    pub fn i64(&mut self) -> Result<i64, CdrError> {
        Ok(self.u64()? as i64)
    }
    pub fn f32(&mut self) -> Result<f32, CdrError> {
        Ok(f32::from_bits(self.u32()?))
    }
    pub fn f64(&mut self) -> Result<f64, CdrError> {
        Ok(f64::from_bits(self.u64()?))
    }
    pub fn str(&mut self) -> Result<&'a str, CdrError> {
        let len = self.u32()? as usize;
        if len == 0 {
            return Ok("");
        }
        let b = self.take(len)?;
        let b = b.strip_suffix(&[0]).unwrap_or(b);
        core::str::from_utf8(b).map_err(|_| CdrError::Utf8)
    }
    pub fn string(&mut self) -> Result<String, CdrError> {
        Ok(String::from(self.str()?))
    }
    /// Reads a sequence length and checks it against the remaining bytes given
    /// the element size, so a corrupt length cannot cause a huge allocation.
    pub fn seq_len(&mut self, elem_size: usize) -> Result<usize, CdrError> {
        let n = self.u32()?;
        if (n as usize).saturating_mul(elem_size) > self.remaining() {
            return Err(CdrError::SequenceTooLong(n));
        }
        Ok(n as usize)
    }
    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], CdrError> {
        self.take(n)
    }
    /// Reads a `float32[]` sequence into `out` (cleared first), avoiding
    /// per-element bounds checks.
    pub fn f32_seq_into(&mut self, out: &mut Vec<f32>) -> Result<(), CdrError> {
        let n = self.seq_len(4)?;
        self.align(4);
        let b = self.take(n * 4)?;
        out.clear();
        out.reserve(n);
        let (chunks, _) = b.as_chunks::<4>();
        if self.little_endian {
            out.extend(chunks.iter().map(|c| f32::from_le_bytes(*c)));
        } else {
            out.extend(chunks.iter().map(|c| f32::from_be_bytes(*c)));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment_is_relative_to_payload_start() {
        let mut w = Writer::new();
        w.u8(1).u64(2);
        // header(4) + u8 at payload offset 0, then pad to 8, then u64 at payload offset 8.
        assert_eq!(w.len(), 4 + 1 + 7 + 8);
        let bytes = w.finish();
        let mut r = Reader::new(&bytes).unwrap();
        assert_eq!(r.u8().unwrap(), 1);
        assert_eq!(r.u64().unwrap(), 2);
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn string_round_trip_and_nul() {
        let mut w = Writer::new();
        w.string("base_link").string("");
        let bytes = w.finish();
        // len includes NUL
        assert_eq!(&bytes[4..8], &10u32.to_le_bytes());
        let mut r = Reader::new(&bytes).unwrap();
        assert_eq!(r.str().unwrap(), "base_link");
        assert_eq!(r.str().unwrap(), "");
    }

    #[test]
    fn header_stamp_matches_ros2_layout() {
        // builtin_interfaces/Time {int32 sec; uint32 nanosec} followed by string frame_id.
        let mut w = Writer::new();
        w.i32(1700000000).u32(5).string("map");
        let bytes = w.finish();
        assert_eq!(bytes.len(), 4 + 4 + 4 + 4 + 4);
        let mut r = Reader::new(&bytes).unwrap();
        assert_eq!(r.i32().unwrap(), 1700000000);
        assert_eq!(r.u32().unwrap(), 5);
        assert_eq!(r.str().unwrap(), "map");
    }

    #[test]
    fn f32_sequence() {
        let data = [1.0f32, 2.5, -3.0];
        let mut w = Writer::new();
        w.f32_seq(&data);
        let bytes = w.finish();
        let mut r = Reader::new(&bytes).unwrap();
        let mut out = Vec::new();
        r.f32_seq_into(&mut out).unwrap();
        assert_eq!(out, data);
    }

    #[test]
    fn big_endian_reader() {
        let mut bytes = vec![0x00, 0x00, 0x00, 0x00];
        bytes.extend_from_slice(&0x0102_0304u32.to_be_bytes());
        let mut r = Reader::new(&bytes).unwrap();
        assert!(!r.is_little_endian());
        assert_eq!(r.u32().unwrap(), 0x0102_0304);
    }

    #[test]
    fn errors() {
        assert_eq!(
            Reader::new(&[0, 1]).unwrap_err(),
            CdrError::Eof {
                at: 0,
                need: 4,
                have: 2
            }
        );
        assert_eq!(
            Reader::new(&[0, 2, 0, 0]).unwrap_err(),
            CdrError::Encapsulation(2)
        );
        let mut r = Reader::new(&[0, 1, 0, 0, 0xff, 0xff, 0xff, 0xff]).unwrap();
        assert_eq!(
            r.seq_len(4).unwrap_err(),
            CdrError::SequenceTooLong(u32::MAX)
        );
        let mut r = Reader::new(&[0, 1, 0, 0, 1]).unwrap();
        assert!(matches!(r.u32(), Err(CdrError::Eof { .. })));
    }
}
