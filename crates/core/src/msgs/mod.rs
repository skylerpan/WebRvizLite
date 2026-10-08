//! Decoders for the ROS 2 message types WebRvizLite understands. Each decoder
//! reads a CDR payload with [`crate::cdr::Reader`] into a plain Rust struct;
//! point clouds and maps decode straight into GPU-ready buffers.

pub mod common;
pub mod geometry;
pub mod marker;
pub mod nav;
pub mod pointcloud;
pub mod tf;

pub use common::{Header, Stamp};
