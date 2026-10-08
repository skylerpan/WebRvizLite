//! Binary frame layout shared by the server (encoder) and the worker (decoder).
//!
//! Spec §4.3: `u8 kind | u32 subscription_id | u64 receive_time_ns | CDR payload`,
//! all little-endian, no padding.

/// Frame kinds carried in the first byte.
pub mod kind {
    /// A ROS message: payload is the raw CDR bytes as received from the RMW.
    pub const MESSAGE: u8 = 0;
}

/// Fixed-size header preceding every binary WebSocket frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub kind: u8,
    pub subscription_id: u32,
    pub receive_time_ns: u64,
}

impl FrameHeader {
    /// Encoded size in bytes: 1 + 4 + 8.
    pub const SIZE: usize = 13;

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        self.encode_into(&mut out);
        out
    }

    /// Writes the header into the first [`Self::SIZE`] bytes of `buf`.
    ///
    /// # Panics
    /// If `buf.len() < Self::SIZE`.
    pub fn encode_into(&self, buf: &mut [u8]) {
        buf[0] = self.kind;
        buf[1..5].copy_from_slice(&self.subscription_id.to_le_bytes());
        buf[5..13].copy_from_slice(&self.receive_time_ns.to_le_bytes());
    }

    /// Splits `bytes` into the decoded header and the remaining payload.
    pub fn decode(bytes: &[u8]) -> Result<(Self, &[u8]), WireError> {
        if bytes.len() < Self::SIZE {
            return Err(WireError::TooShort { len: bytes.len() });
        }
        let (head, payload) = bytes.split_at(Self::SIZE);
        let header = Self {
            kind: head[0],
            subscription_id: u32::from_le_bytes([head[1], head[2], head[3], head[4]]),
            receive_time_ns: u64::from_le_bytes([
                head[5], head[6], head[7], head[8], head[9], head[10], head[11], head[12],
            ]),
        };
        Ok((header, payload))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum WireError {
    #[error("frame too short: {len} bytes, need at least {}", FrameHeader::SIZE)]
    TooShort { len: usize },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let h = FrameHeader {
            kind: kind::MESSAGE,
            subscription_id: 0xDEAD_BEEF,
            receive_time_ns: 1_700_000_000_123_456_789,
        };
        let mut frame = h.encode().to_vec();
        frame.extend_from_slice(&[1, 2, 3]);
        let (decoded, payload) = FrameHeader::decode(&frame).unwrap();
        assert_eq!(decoded, h);
        assert_eq!(payload, &[1, 2, 3]);
    }

    #[test]
    fn layout_is_little_endian_and_packed() {
        let h = FrameHeader {
            kind: 7,
            subscription_id: 0x0403_0201,
            receive_time_ns: 0x0C0B_0A09_0807_0605,
        };
        assert_eq!(h.encode(), [7, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }

    #[test]
    fn empty_payload_is_ok() {
        let h = FrameHeader {
            kind: 0,
            subscription_id: 1,
            receive_time_ns: 2,
        };
        let encoded = h.encode();
        let (d, p) = FrameHeader::decode(&encoded).unwrap();
        assert_eq!(d, h);
        assert!(p.is_empty());
    }

    #[test]
    fn too_short_is_error() {
        assert_eq!(
            FrameHeader::decode(&[0u8; 12]),
            Err(WireError::TooShort { len: 12 })
        );
    }
}
