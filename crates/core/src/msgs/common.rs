use crate::cdr::{CdrError, Reader};
#[cfg(not(feature = "std"))]
use alloc::string::String;

/// builtin_interfaces/msg/Time
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stamp {
    pub sec: i32,
    pub nanosec: u32,
}

impl Stamp {
    pub fn read(r: &mut Reader) -> Result<Self, CdrError> {
        Ok(Self {
            sec: r.i32()?,
            nanosec: r.u32()?,
        })
    }
    /// Nanoseconds since epoch; negative seconds clamp to 0.
    pub fn to_ns(self) -> u64 {
        if self.sec < 0 {
            return 0;
        }
        self.sec as u64 * 1_000_000_000 + self.nanosec as u64
    }
}

/// std_msgs/msg/Header
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Header {
    pub stamp: Stamp,
    pub frame_id: String,
}

impl Header {
    pub fn read(r: &mut Reader) -> Result<Self, CdrError> {
        Ok(Self {
            stamp: Stamp::read(r)?,
            frame_id: r.string()?,
        })
    }
}

pub fn read_vec3(r: &mut Reader) -> Result<[f64; 3], CdrError> {
    Ok([r.f64()?, r.f64()?, r.f64()?])
}

pub fn read_quat(r: &mut Reader) -> Result<[f64; 4], CdrError> {
    Ok([r.f64()?, r.f64()?, r.f64()?, r.f64()?])
}
