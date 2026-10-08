//! WebRvizLite core.
//!
//! Shared between the native server and the WASM worker. Must stay free of
//! r2r, tokio, or anything that only runs natively; `std` is an optional
//! feature so the crate can be used in `no_std` contexts later.

#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]

#[cfg(not(feature = "std"))]
extern crate alloc;

pub mod cdr;
pub mod covariance;
pub mod image;
pub mod math;
pub mod msgs;
pub mod pointcloud;
pub mod protocol;
pub mod tf;
pub mod wire;
