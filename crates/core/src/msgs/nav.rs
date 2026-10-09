//! nav_msgs/OccupancyGrid, nav_msgs/Path, map_msgs/OccupancyGridUpdate

use super::common::{Header, Stamp};
use super::geometry::{POSE_SIZE, read_covariance, read_pose};
use crate::cdr::{CdrError, Reader};
use crate::math::Transform;
#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

/// nav_msgs/msg/MapMetaData + the cell data.
#[derive(Debug, Clone, PartialEq)]
pub struct OccupancyGrid {
    pub header: Header,
    pub map_load_time: Stamp,
    pub resolution: f32,
    pub width: u32,
    pub height: u32,
    pub origin: Transform,
    /// Row-major, `width * height` cells; int8 values stored as u8 (-1 → 255).
    pub data: Vec<u8>,
}

pub fn decode_occupancy_grid(bytes: &[u8]) -> Result<OccupancyGrid, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let map_load_time = Stamp::read(&mut r)?;
    let resolution = r.f32()?;
    let width = r.u32()?;
    let height = r.u32()?;
    let origin = read_pose(&mut r)?;
    let n = r.seq_len(1)?;
    if n != (width as usize) * (height as usize) {
        return Err(CdrError::SequenceTooLong(n as u32));
    }
    let data = r.bytes(n)?.to_vec();
    Ok(OccupancyGrid {
        header,
        map_load_time,
        resolution,
        width,
        height,
        origin,
        data,
    })
}

/// map_msgs/msg/OccupancyGridUpdate: a rectangular patch.
#[derive(Debug, Clone, PartialEq)]
pub struct OccupancyGridUpdate {
    pub header: Header,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

pub fn decode_occupancy_grid_update(bytes: &[u8]) -> Result<OccupancyGridUpdate, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let x = r.i32()?;
    let y = r.i32()?;
    let width = r.u32()?;
    let height = r.u32()?;
    let n = r.seq_len(1)?;
    if n != (width as usize) * (height as usize) {
        return Err(CdrError::SequenceTooLong(n as u32));
    }
    let data = r.bytes(n)?.to_vec();
    Ok(OccupancyGridUpdate {
        header,
        x,
        y,
        width,
        height,
        data,
    })
}

/// nav_msgs/msg/Path: the per-pose headers are read but only the path header is kept.
#[derive(Debug, Clone, PartialEq)]
pub struct Path {
    pub header: Header,
    pub poses: Vec<Transform>,
}

pub fn decode_path(bytes: &[u8]) -> Result<Path, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let n = r.seq_len(8 + 4 + POSE_SIZE)?; // PoseStamped: header(stamp 8 + string ≥4) + pose
    let mut poses = Vec::with_capacity(n);
    for _ in 0..n {
        let _h = Header::read(&mut r)?;
        poses.push(read_pose(&mut r)?);
    }
    Ok(Path { header, poses })
}

/// nav_msgs/msg/Odometry: pose (+ covariance) and twist (+ covariance) in `child_frame_id`.
#[derive(Debug, Clone, PartialEq)]
pub struct Odometry {
    pub header: Header,
    pub child_frame_id: String,
    pub pose: Transform,
    pub pose_covariance: [f64; 36],
    /// linear xyz, angular xyz
    pub twist: [f64; 6],
    pub twist_covariance: [f64; 36],
}

pub fn decode_odometry(bytes: &[u8]) -> Result<Odometry, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let child_frame_id = r.string()?;
    let pose = read_pose(&mut r)?;
    let pose_covariance = read_covariance(&mut r)?;
    let mut twist = [0.0; 6];
    for v in twist.iter_mut() {
        *v = r.f64()?;
    }
    let twist_covariance = read_covariance(&mut r)?;
    Ok(Odometry {
        header,
        child_frame_id,
        pose,
        pose_covariance,
        twist,
        twist_covariance,
    })
}

/// nav_msgs/msg/GridCells: cell size and centres (Point32 → flat xyz f32).
#[derive(Debug, Clone, PartialEq)]
pub struct GridCells {
    pub header: Header,
    pub cell_width: f32,
    pub cell_height: f32,
    pub cells: Vec<f32>,
}

pub fn decode_grid_cells(bytes: &[u8]) -> Result<GridCells, CdrError> {
    let mut r = Reader::new(bytes)?;
    let header = Header::read(&mut r)?;
    let cell_width = r.f32()?;
    let cell_height = r.f32()?;
    let n = r.seq_len(12)?;
    let mut cells = Vec::with_capacity(n * 3);
    for _ in 0..n {
        cells.push(r.f32()?);
        cells.push(r.f32()?);
        cells.push(r.f32()?);
    }
    Ok(GridCells {
        header,
        cell_width,
        cell_height,
        cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdr::Writer;

    #[test]
    fn odometry_and_grid_cells() {
        let mut w = Writer::new();
        w.i32(1).u32(0).string("odom").string("base_link");
        for v in [1.0f64, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0] {
            w.f64(v);
        }
        for i in 0..36 {
            w.f64(if i % 7 == 0 { 0.1 } else { 0.0 });
        }
        for v in [0.5f64, 0.0, 0.0, 0.0, 0.0, 0.2] {
            w.f64(v);
        }
        for _ in 0..36 {
            w.f64(0.0);
        }
        let o = decode_odometry(&w.finish()).unwrap();
        assert_eq!(o.child_frame_id, "base_link");
        assert_eq!(o.pose.t, [1.0, 2.0, 0.0]);
        assert_eq!(o.pose_covariance[0], 0.1);
        assert_eq!(o.twist, [0.5, 0.0, 0.0, 0.0, 0.0, 0.2]);

        let mut w = Writer::new();
        w.i32(1).u32(0).string("map").f32(0.1).f32(0.1).seq_len(2);
        w.f32(0.0).f32(0.0).f32(0.0).f32(0.1).f32(0.0).f32(0.0);
        let g = decode_grid_cells(&w.finish()).unwrap();
        assert_eq!((g.cell_width, g.cell_height), (0.1, 0.1));
        assert_eq!(g.cells, vec![0.0, 0.0, 0.0, 0.1, 0.0, 0.0]);
        // corrupt length rejected
        let mut w = Writer::new();
        w.i32(1)
            .u32(0)
            .string("map")
            .f32(0.1)
            .f32(0.1)
            .u32(1_000_000);
        assert!(decode_grid_cells(&w.finish()).is_err());
    }

    #[test]
    fn occupancy_grid_round_trip() {
        let mut w = Writer::new();
        w.i32(1).u32(0).string("map"); // header
        w.i32(0).u32(0); // map_load_time
        w.f32(0.05).u32(3).u32(2);
        for v in [1.0f64, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0] {
            w.f64(v);
        }
        w.seq_len(6).bytes(&[0, 100, 255, 50, 0, 0]);
        let g = decode_occupancy_grid(&w.finish()).unwrap();
        assert_eq!((g.width, g.height), (3, 2));
        assert_eq!(g.resolution, 0.05);
        assert_eq!(g.origin.t, [1.0, 2.0, 0.0]);
        assert_eq!(g.data, vec![0, 100, 255, 50, 0, 0]);
    }

    #[test]
    fn occupancy_grid_size_mismatch_is_error() {
        let mut w = Writer::new();
        w.i32(1)
            .u32(0)
            .string("map")
            .i32(0)
            .u32(0)
            .f32(0.05)
            .u32(3)
            .u32(2);
        for _ in 0..7 {
            w.f64(0.0);
        }
        w.seq_len(5).bytes(&[0; 5]);
        assert!(decode_occupancy_grid(&w.finish()).is_err());
    }

    #[test]
    fn path_and_update() {
        let mut w = Writer::new();
        w.i32(1).u32(0).string("map");
        w.seq_len(2);
        for i in 0..2 {
            w.i32(1).u32(0).string("map");
            for v in [i as f64, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0] {
                w.f64(v);
            }
        }
        let p = decode_path(&w.finish()).unwrap();
        assert_eq!(p.poses.len(), 2);
        assert_eq!(p.poses[1].t[0], 1.0);

        let mut w = Writer::new();
        w.i32(1)
            .u32(0)
            .string("map")
            .i32(4)
            .i32(5)
            .u32(2)
            .u32(1)
            .seq_len(2)
            .bytes(&[7, 8]);
        let u = decode_occupancy_grid_update(&w.finish()).unwrap();
        assert_eq!((u.x, u.y, u.width, u.height), (4, 5, 2, 1));
        assert_eq!(u.data, vec![7, 8]);
    }
}
