//! std_msgs: String (robot_description).

use crate::cdr::{CdrError, Reader};
#[cfg(not(feature = "std"))]
use alloc::string::String;

pub fn decode_string(bytes: &[u8]) -> Result<String, CdrError> {
    let mut r = Reader::new(bytes)?;
    r.string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdr::Writer;

    #[test]
    fn string_round_trip() {
        let mut w = Writer::new();
        w.string("<robot name=\"x\"/>");
        assert_eq!(decode_string(&w.finish()).unwrap(), "<robot name=\"x\"/>");
        assert!(decode_string(&[0, 1, 0, 0, 5, 0, 0, 0]).is_err());
    }
}
