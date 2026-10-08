#!/usr/bin/env python3
"""Publishes the same synthetic scene as the server's `--mock` transport, but
through a real ROS 2 node (rclpy), so the r2r bridge path (DDS → subscribe_raw
→ WebSocket → WASM decoders) can be exercised without hardware.

Mirrors crates/bridge/src/mock.rs: an 8 m × 6 m room with a pillar, a robot
driving a 2 m circle, and every topic `fixtures/mock_scene.rviz` subscribes to:

  /tf 30 Hz · /tf_static · /clock 20 Hz · /scan 10 Hz · /map (latched) ·
  /plan, /goal_pose, /particlecloud 2 Hz · /points 10 Hz (PointCloud2) ·
  /markers, /marker 1 Hz · /livox/lidar 10 Hz (livox_ros_driver2/CustomMsg) ·
  Tier 1: /odom 20 Hz · /amcl_pose, /grid_cells 1 Hz · /clicked_point_echo 2 Hz ·
  /footprint 5 Hz · /range 10 Hz

Sizes default smaller than the Rust mock because rclpy serialises in Python:
--points 100000, --cubes 5000, --livox-points 4000.

Run inside the ROS container:  make docker-mock-ros
"""
import argparse
import array
import math
import time
from pathlib import Path

import numpy as np
import rclpy
from builtin_interfaces.msg import Duration
from geometry_msgs.msg import Point, Point32, PointStamped, Polygon, PolygonStamped, Pose, PoseArray, PoseStamped, PoseWithCovarianceStamped, TransformStamped
from livox_ros_driver2.msg import CustomMsg, CustomPoint
from nav_msgs.msg import GridCells, OccupancyGrid, Odometry, Path
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from rosgraph_msgs.msg import Clock
from sensor_msgs.msg import LaserScan, PointCloud2, PointField, Range
from std_msgs.msg import ColorRGBA, String
from tf2_msgs.msg import TFMessage
from visualization_msgs.msg import Marker, MarkerArray

ROOM_HALF_X, ROOM_HALF_Y = 4.0, 3.0
ROOM_CEILING = 2.5
CIRCLE_RADIUS, CIRCLE_PERIOD_S = 2.0, 20.0
BEAMS = 360
MAP_RESOLUTION = 0.05
LIVOX_HEIGHT = 0.5
GOLDEN = math.pi * (3.0 - math.sqrt(5.0))


def ray_to_walls(x, y, theta):
    """Distance from (x, y) along theta to the room walls. Works on numpy arrays too."""
    dx, dy = np.cos(theta), np.sin(theta)
    with np.errstate(divide='ignore', invalid='ignore'):
        tx = np.where(dx > 0, ROOM_HALF_X - x, -ROOM_HALF_X - x) / dx
        ty = np.where(dy > 0, ROOM_HALF_Y - y, -ROOM_HALF_Y - y) / dy
    tx = np.where(np.abs(dx) > 1e-9, tx, np.inf)
    ty = np.where(np.abs(dy) > 1e-9, ty, np.inf)
    return np.minimum(tx, ty)


def pose_msg(x, y, yaw, z=0.0):
    p = Pose()
    p.position.x, p.position.y, p.position.z = float(x), float(y), float(z)
    p.orientation.z, p.orientation.w = math.sin(yaw / 2), math.cos(yaw / 2)
    return p


def tf(stamp, parent, child, x, y, z, yaw=0.0):
    t = TransformStamped()
    t.header.stamp = stamp
    t.header.frame_id = parent
    t.child_frame_id = child
    t.transform.translation.x, t.transform.translation.y, t.transform.translation.z = x, y, z
    t.transform.rotation.z = math.sin(yaw / 2)
    t.transform.rotation.w = math.cos(yaw / 2)
    return t


def color(r, g, b, a=1.0):
    return ColorRGBA(r=float(r), g=float(g), b=float(b), a=float(a))


def point(x, y, z):
    return Point(x=float(x), y=float(y), z=float(z))


def marker(ns, mid, kind, xyz, scale, rgba=(1.0, 1.0, 1.0, 1.0), *, frame='map', action=Marker.ADD,
           yaw=0.0, points=(), colors=(), text='', mesh='', lifetime_s=0, frame_locked=False):
    m = Marker()
    m.header.frame_id = frame
    m.ns, m.id, m.type, m.action = ns, mid, kind, action
    m.pose = pose_msg(xyz[0], xyz[1], yaw, xyz[2])
    m.scale.x, m.scale.y, m.scale.z = (float(v) for v in scale)
    m.color = color(*rgba)
    m.lifetime = Duration(sec=lifetime_s)
    m.frame_locked = frame_locked
    m.points = [point(*p) for p in points]
    m.colors = [color(*c) for c in colors]
    m.text, m.mesh_resource = text, mesh
    return m


class MockScene(Node):
    def __init__(self, n_points, n_cubes, n_livox):
        super().__init__('mock_scene')
        self.start = time.monotonic()
        self.phase = 0
        sensor_qos = QoSProfile(depth=5, reliability=ReliabilityPolicy.BEST_EFFORT)
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.tf_pub = self.create_publisher(TFMessage, '/tf', 100)
        self.tf_static_pub = self.create_publisher(TFMessage, '/tf_static', QoSProfile(depth=100, durability=DurabilityPolicy.TRANSIENT_LOCAL))
        self.clock_pub = self.create_publisher(Clock, '/clock', 10)
        self.scan_pub = self.create_publisher(LaserScan, '/scan', sensor_qos)
        self.map_pub = self.create_publisher(OccupancyGrid, '/map', latched)
        self.path_pub = self.create_publisher(Path, '/plan', 2)
        self.goal_pub = self.create_publisher(PoseStamped, '/goal_pose', 2)
        self.particles_pub = self.create_publisher(PoseArray, '/particlecloud', 2)
        self.points_pub = self.create_publisher(PointCloud2, '/points', sensor_qos)
        self.markers_pub = self.create_publisher(MarkerArray, '/markers', 2)
        self.marker_pub = self.create_publisher(Marker, '/marker', 2)
        self.livox_pub = self.create_publisher(CustomMsg, '/livox/lidar', sensor_qos)
        self.odom_pub = self.create_publisher(Odometry, '/odom', 10)
        self.amcl_pub = self.create_publisher(PoseWithCovarianceStamped, '/amcl_pose', 2)
        self.point_pub = self.create_publisher(PointStamped, '/clicked_point_echo', 2)
        self.footprint_pub = self.create_publisher(PolygonStamped, '/footprint', 2)
        self.grid_cells_pub = self.create_publisher(GridCells, '/grid_cells', 2)
        self.range_pub = self.create_publisher(Range, '/range', 10)
        self.urdf_pub = self.create_publisher(String, '/robot_description', latched)

        self.n_points = int(math.sqrt(n_points)) ** 2
        self.n_cubes = n_cubes
        self.n_livox = n_livox
        self._prepare_points()
        self._prepare_cubes()
        self._prepare_livox()

        stamp = self.now()
        optical = TransformStamped()
        optical.header.stamp, optical.header.frame_id, optical.child_frame_id = stamp, 'camera_link', 'camera_optical_frame'
        optical.transform.rotation.x, optical.transform.rotation.y, optical.transform.rotation.z, optical.transform.rotation.w = -0.5, 0.5, -0.5, 0.5
        self.tf_static_pub.publish(TFMessage(transforms=[
            tf(stamp, 'base_footprint', 'base_link', 0.0, 0.0, 0.0),
            tf(stamp, 'base_link', 'wheel_left_link', 0.0, 0.28, 0.127),
            tf(stamp, 'base_link', 'wheel_right_link', 0.0, -0.28, 0.127),
            tf(stamp, 'base_link', 'caster_front_link', 0.22, 0.0, 0.05),
            tf(stamp, 'base_link', 'camera_link', 0.28, 0.0, 0.4),
            optical,
            tf(stamp, 'base_link', 'laser', 0.2, 0.0, 0.3),
            tf(stamp, 'base_link', 'livox_frame', 0.0, 0.0, LIVOX_HEIGHT),
        ]))
        urdf = Path(__file__).resolve().parent.parent / 'fixtures' / 'robot_description' / 'tier1_robot.urdf'
        self.urdf_pub.publish(String(data=urdf.read_text()))
        self.map_pub.publish(self.make_map(stamp))

        self.create_timer(1 / 30, self.publish_tf)
        self.create_timer(1 / 20, self.publish_clock)
        self.create_timer(0.1, self.publish_fast)
        self.create_timer(0.5, self.publish_nav)
        self.create_timer(1.0, self.publish_markers)
        self.create_timer(0.05, self.publish_odom)
        self.create_timer(0.1, self.publish_range)
        self.create_timer(0.2, self.publish_footprint)
        self.create_timer(0.5, self.publish_point)
        self.create_timer(1.0, self.publish_covariance_and_cells)
        self.get_logger().info(
            f'publishing mock scene: /points {self.n_points} pts, /markers {n_cubes} cubes, /livox/lidar {n_livox} pts')

    # ---- helpers --------------------------------------------------------

    def now(self):
        return self.get_clock().now().to_msg()

    def pose(self):
        a = (time.monotonic() - self.start) / CIRCLE_PERIOD_S * math.tau
        return CIRCLE_RADIUS * math.cos(a), CIRCLE_RADIUS * math.sin(a), a + math.pi / 2

    # ---- tf / clock -----------------------------------------------------

    def publish_tf(self):
        x, y, yaw = self.pose()
        stamp = self.now()
        self.tf_pub.publish(TFMessage(transforms=[tf(stamp, 'map', 'odom', 0.0, 0.0, 0.0), tf(stamp, 'odom', 'base_footprint', x, y, 0.0, yaw)]))

    def publish_clock(self):
        self.clock_pub.publish(Clock(clock=self.now()))

    # ---- map (once, latched) --------------------------------------------

    def make_map(self, stamp):
        border = 1.0
        w = int((ROOM_HALF_X + border) * 2 / MAP_RESOLUTION)
        h = int((ROOM_HALF_Y + border) * 2 / MAP_RESOLUTION)
        i = np.arange(w)[None, :]
        j = np.arange(h)[:, None]
        x = -(ROOM_HALF_X + border) + (i + 0.5) * MAP_RESOLUTION
        y = -(ROOM_HALF_Y + border) + (j + 0.5) * MAP_RESOLUTION
        inside = (np.abs(x) < ROOM_HALF_X) & (np.abs(y) < ROOM_HALF_Y)
        wall = ~inside & (np.abs(x) < ROOM_HALF_X + 0.1) & (np.abs(y) < ROOM_HALF_Y + 0.1)
        pillar = np.sqrt((x - 2.5) ** 2 + (y + 1.5) ** 2)
        data = np.full((h, w), -1, dtype=np.int8)
        data[inside] = 0
        grad = inside & (pillar < 0.9) & (pillar >= 0.3)
        data[grad] = (99.0 * (1.0 - (pillar[grad] - 0.3) / 0.6)).astype(np.int8)
        data[inside & (pillar < 0.3)] = 100
        data[wall] = 100
        m = OccupancyGrid()
        m.header.stamp = stamp
        m.header.frame_id = 'map'
        m.info.map_load_time = stamp
        m.info.resolution = MAP_RESOLUTION
        m.info.width, m.info.height = w, h
        m.info.origin = pose_msg(-(ROOM_HALF_X + border), -(ROOM_HALF_Y + border), 0.0)
        m.data = array.array('b', data.ravel().tolist())
        return m

    # ---- 10 Hz: scan, points, livox ---------------------------------------

    def publish_fast(self):
        self.phase += 1
        stamp = self.now()
        x, y, yaw = self.pose()
        self.scan_pub.publish(self.make_scan(stamp, x, y, yaw))
        self.points_pub.publish(self.make_points(stamp))
        self.livox_pub.publish(self.make_livox(stamp, x, y, yaw))

    def make_scan(self, stamp, x, y, yaw):
        lx, ly = x + 0.2 * math.cos(yaw), y + 0.2 * math.sin(yaw)
        m = LaserScan()
        m.header.stamp = stamp
        m.header.frame_id = 'laser'
        m.angle_min, m.angle_max = -math.pi, math.pi
        m.angle_increment = (m.angle_max - m.angle_min) / BEAMS
        m.scan_time, m.range_min, m.range_max = 0.1, 0.05, 12.0
        angles = m.angle_min + (np.arange(BEAMS) + 0.5) * m.angle_increment + yaw
        m.ranges = ray_to_walls(lx, ly, angles).astype(np.float32).tolist()
        m.intensities = (100.0 + 50.0 * np.sin(3 * angles)).astype(np.float32).tolist()
        return m

    def _prepare_points(self):
        side = int(math.sqrt(self.n_points))
        j, i = np.meshgrid(np.arange(side), np.arange(side), indexing='ij')
        self.px = (i / side - 0.5) * 6.0
        self.py = (j / side - 0.5) * 6.0
        self.pr = np.sqrt(self.px ** 2 + self.py ** 2)
        rgb = (((self.px + 3.0) / 6.0 * 255).astype(np.uint32) << 16) | (((self.py + 3.0) / 6.0 * 255).astype(np.uint32) << 8) | 128
        self.pbuf = np.zeros(self.n_points, dtype=[('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('intensity', '<f4'), ('rgb', '<u4')])
        self.pbuf['x'], self.pbuf['y'], self.pbuf['rgb'] = self.px.ravel(), self.py.ravel(), rgb.ravel()
        self.pfields = [PointField(name=n, offset=o, datatype=PointField.FLOAT32, count=1)
                        for n, o in (('x', 0), ('y', 4), ('z', 8), ('intensity', 12), ('rgb', 16))]

    def make_points(self, stamp):
        t = self.phase * 0.1
        z = 0.3 * np.sin(self.pr * 3.0 - t * 2.0) * np.exp(-self.pr * 0.4)
        self.pbuf['z'] = z.ravel()
        self.pbuf['intensity'] = ((z + 0.3) / 0.6 * 255.0).ravel()
        m = PointCloud2()
        m.header.stamp = stamp
        m.header.frame_id = 'laser'
        m.height, m.width = 1, self.n_points
        m.fields = self.pfields
        m.is_bigendian = False
        m.point_step, m.row_step = 20, 20 * self.n_points
        m.data = array.array('B', self.pbuf.tobytes())
        m.is_dense = True
        return m

    def _prepare_livox(self):
        n = self.n_livox
        self.li = np.arange(n, dtype=np.float64)
        self.lpoints = [CustomPoint(offset_time=int(i * 100_000_000 / n), tag=16 if i % 13 == 0 else 0, line=i % 4) for i in range(n)]
        self.lnoise = ((np.arange(n) * 7919) % 23).astype(np.int64)

    def make_livox(self, stamp, x, y, yaw):
        n = self.n_livox
        t = self.phase * 0.1
        az = (self.li * GOLDEN + t * 0.7) % math.tau
        el = 0.7 * np.sin(self.li * 0.0137 + t)
        sin_el, cos_el = np.sin(el), np.cos(el)
        d_wall = ray_to_walls(x, y, yaw + az)
        with np.errstate(divide='ignore'):
            d_vert = np.where(el < -1e-3, LIVOX_HEIGHT / np.tan(-el),
                              np.where(el > 1e-3, (ROOM_CEILING - LIVOX_HEIGHT) / np.tan(el), np.inf))
        hit_vert = d_vert < d_wall
        d = np.where(hit_vert, d_vert, d_wall)
        refl = np.where(hit_vert, np.where(el < 0, 60, 90), 150) + self.lnoise
        rng = d / cos_el
        px, py, pz = rng * cos_el * np.cos(az), rng * cos_el * np.sin(az), rng * sin_el
        no_return = (np.arange(n) % 97) == 0
        px[no_return] = py[no_return] = pz[no_return] = 0.0
        refl[no_return] = 0
        px, py, pz, refl = px.tolist(), py.tolist(), pz.tolist(), refl.tolist()
        for i, p in enumerate(self.lpoints):
            p.x, p.y, p.z, p.reflectivity = px[i], py[i], pz[i], refl[i]
        m = CustomMsg()
        m.header.stamp = stamp
        m.header.frame_id = 'livox_frame'
        m.timebase = stamp.sec * 1_000_000_000 + stamp.nanosec
        m.point_num = n
        m.lidar_id = 0
        m.points = self.lpoints
        return m

    # ---- 2 Hz: path, goal, particles --------------------------------------

    def publish_nav(self):
        stamp = self.now()
        x, y, yaw = self.pose()
        a0 = yaw - math.pi / 2
        path = Path()
        path.header.stamp, path.header.frame_id = stamp, 'map'
        for i in range(40):
            a = a0 + i / 40 * math.pi
            ps = PoseStamped()
            ps.header.stamp, ps.header.frame_id = stamp, 'map'
            ps.pose = pose_msg(CIRCLE_RADIUS * math.cos(a), CIRCLE_RADIUS * math.sin(a), a + math.pi / 2)
            path.poses.append(ps)
        self.path_pub.publish(path)

        a = a0 + math.pi
        goal = PoseStamped()
        goal.header.stamp, goal.header.frame_id = stamp, 'map'
        goal.pose = pose_msg(CIRCLE_RADIUS * math.cos(a), CIRCLE_RADIUS * math.sin(a), a + math.pi / 2)
        self.goal_pub.publish(goal)

        pa = PoseArray()
        pa.header.stamp, pa.header.frame_id = stamp, 'odom'
        for i in range(60):
            a = i * 2.399
            r = 0.05 + 0.25 * i / 60
            pa.poses.append(pose_msg(x + r * math.cos(a), y + r * math.sin(a), yaw + 0.3 * math.sin(a * 0.5)))
        self.particles_pub.publish(pa)

    # ---- Tier 1 topics ------------------------------------------------------

    @staticmethod
    def covariance(diag, xy=0.0):
        cov = [0.0] * 36
        for i, v in enumerate(diag):
            cov[i * 6 + i] = float(v)
        cov[1] = cov[6] = float(xy)
        return cov

    def publish_odom(self):
        x, y, yaw = self.pose()
        m = Odometry()
        m.header.stamp, m.header.frame_id, m.child_frame_id = self.now(), 'odom', 'base_link'
        m.pose.pose = pose_msg(x, y, yaw)
        m.pose.covariance = self.covariance([0.02, 0.02, 0, 0, 0, 0.01])
        m.twist.twist.linear.x = CIRCLE_RADIUS * math.tau / CIRCLE_PERIOD_S
        m.twist.twist.angular.z = math.tau / CIRCLE_PERIOD_S
        m.twist.covariance = self.covariance([0.001] * 6)
        self.odom_pub.publish(m)

    def publish_range(self):
        x, y, yaw = self.pose()
        m = Range()
        m.header.stamp, m.header.frame_id = self.now(), 'laser'
        m.radiation_type, m.field_of_view, m.min_range, m.max_range = Range.ULTRASOUND, 0.5, 0.05, 4.0
        m.range = float(min(4.0, ray_to_walls(x + 0.2 * math.cos(yaw), y + 0.2 * math.sin(yaw), yaw)))
        self.range_pub.publish(m)

    def publish_footprint(self):
        m = PolygonStamped()
        m.header.stamp, m.header.frame_id = self.now(), 'base_link'
        pts = [(0.30, 0.20), (0.25, 0.25), (-0.25, 0.25), (-0.30, 0.20), (-0.30, -0.20), (-0.25, -0.25), (0.25, -0.25), (0.30, -0.20)]
        m.polygon = Polygon(points=[Point32(x=float(px), y=float(py), z=0.0) for px, py in pts])
        self.footprint_pub.publish(m)

    def publish_point(self):
        x, y, yaw = self.pose()
        a = yaw - math.pi / 2 + math.pi
        t = time.monotonic() * 0.6
        m = PointStamped()
        m.header.stamp, m.header.frame_id = self.now(), 'map'
        m.point = point(CIRCLE_RADIUS * math.cos(a) + 0.5 * math.cos(t), CIRCLE_RADIUS * math.sin(a) + 0.5 * math.sin(t), 0.3 + 0.1 * math.sin(2 * t))
        self.point_pub.publish(m)

    def publish_covariance_and_cells(self):
        x, y, yaw = self.pose()
        stamp = self.now()
        wobble = math.sin(self.phase * 0.07) * 0.05
        m = PoseWithCovarianceStamped()
        m.header.stamp, m.header.frame_id = stamp, 'map'
        m.pose.pose = pose_msg(x + wobble, y - wobble, yaw + 0.05 * wobble)
        m.pose.covariance = self.covariance([0.05, 0.08, 0.01, 0.01, 0.02, 0.05], 0.02)
        self.amcl_pub.publish(m)

        g = GridCells()
        g.header.stamp, g.header.frame_id = stamp, 'map'
        g.cell_width = g.cell_height = 0.1
        r0 = 1.0 + 0.3 * math.sin(time.monotonic() * 0.5)
        for i in range(-20, 20):
            for j in range(-20, 20):
                cx, cy = i * 0.1 + 0.05, j * 0.1 + 0.05
                d = math.hypot(cx, cy)
                if r0 <= d < r0 + 0.25:
                    g.cells.append(Point32(x=cx, y=cy, z=0.0))
        self.grid_cells_pub.publish(g)

    # ---- 1 Hz: markers ------------------------------------------------------

    def _prepare_cubes(self):
        side = 71
        self.cubes = []
        for i in range(self.n_cubes):
            m = marker('cubes', i, Marker.CUBE, ((i % side) * 0.1 - 3.5, (i // side) * 0.1 - 3.5, 1.5), (0.06, 0.06, 0.06))
            self.cubes.append(m)

    def publish_markers(self):
        phase = self.phase // 10  # 1 Hz phase, like the Rust mock's marker task
        stamp = self.now()
        x, y, _yaw = self.pose()
        base = (-3.5, 2.0, 0.5)
        spot = lambda i: (base[0] + i * 0.6, base[1], base[2])  # noqa: E731
        grid_pts = [((i % 3) * 0.15, (i // 3 % 3) * 0.15, (i // 9) * 0.15) for i in range(27)]
        grid_colors = [((i % 3) / 2, (i // 3 % 3) / 2, (i // 9) / 2, 1.0) for i in range(27)]
        list_pts = [(0, 0, 0), (0, 0, 0.4), (0.2, 0, 0), (0.2, 0, 0.4)]
        list_colors = [(1, 0, 0, 1), (1, 0, 0, 1), (0, 0, 1, 1), (0, 0, 1, 1)]
        demo = [
            marker('demo', 0, Marker.ARROW, spot(0), (0.5, 0.05, 0.05), (1, 0, 0, 1)),
            marker('demo', 1, Marker.ARROW, spot(1), (0.05, 0.1, 0.1), (1, 0.5, 0, 1), points=[(0, 0, 0), (0, 0, 0.5)]),
            marker('demo', 2, Marker.CUBE, spot(2), (0.2, 0.2, 0.2), (0, 1, 0, 1)),
            marker('demo', 3, Marker.SPHERE, spot(3), (0.2, 0.2, 0.2), (0, 0.5, 1, 1)),
            marker('demo', 4, Marker.CYLINDER, spot(4), (0.2, 0.2, 0.4), (1, 1, 0, 1)),
            marker('demo', 5, Marker.LINE_STRIP, spot(5), (0.03, 0, 0), (1, 0, 1, 1), points=[(0, 0, 0), (0.3, 0, 0.3), (0.6, 0, 0), (0.9, 0, 0.3)]),
            marker('demo', 6, Marker.LINE_LIST, spot(7), (0.03, 0, 0), points=list_pts, colors=list_colors),
            marker('demo', 7, Marker.CUBE_LIST, spot(8), (0.1, 0.1, 0.1), points=grid_pts, colors=grid_colors),
            marker('demo', 8, Marker.SPHERE_LIST, spot(9), (0.1, 0.1, 0.1), (0, 1, 1, 1), points=grid_pts),
            marker('demo', 9, Marker.POINTS, spot(10), (0.05, 0.05, 0), points=grid_pts),
            marker('demo', 10, Marker.TEXT_VIEW_FACING, spot(11), (0, 0, 0.25), text='TEXT_VIEW_FACING'),
            marker('demo', 11, Marker.MESH_RESOURCE, spot(12), (1, 1, 1), (0.8, 0.8, 0.8, 1), mesh='package://nonexistent_pkg/meshes/robot.dae'),
            marker('demo', 12, Marker.TRIANGLE_LIST, spot(13), (1, 1, 1), (0.2, 0.8, 0.2, 0.7),
                   points=[(0, 0, 0), (0.4, 0, 0), (0.2, 0, 0.4), (0.4, 0, 0), (0.8, 0, 0), (0.6, 0, 0.4)]),
            # frame-locked cube riding on base_link
            marker('demo', 13, Marker.CUBE, (0, 0, 0.6), (0.15, 0.15, 0.15), (1, 0.3, 0.3, 1), frame='base_link', frame_locked=True),
            # invalid marker: NaN scale → must be rejected without breaking the rest
            marker('demo', 14, Marker.CUBE, spot(14), (float('nan'), 0.2, 0.2)),
        ]
        if phase % 3 == 0:  # lifetime marker: sent every 3 s with a 1 s lifetime → blinks
            demo.append(marker('lifetime', 0, Marker.SPHERE, (x, y, 1.0), (0.3, 0.3, 0.3), (1, 1, 0, 1), lifetime_s=1))
        if phase % 4 < 2:  # DELETE toggling every 2 s
            demo.append(marker('toggle', 0, Marker.CYLINDER, (3.5, 2.5, 0.3), (0.3, 0.3, 0.6), (0.5, 0, 1, 1)))
        else:
            demo.append(marker('toggle', 0, Marker.CUBE, (0, 0, 0), (0.2, 0.2, 0.2), action=Marker.DELETE))
        if phase % 20 == 0:  # DELETEALL wipes every marker in the display
            demo.insert(0, marker('', 0, Marker.CUBE, (0, 0, 0), (0.2, 0.2, 0.2), action=Marker.DELETEALL))
        for i, c in enumerate(self.cubes):
            hue = (i * 0.013 + phase * 0.1) % 1.0
            c.header.stamp = stamp
            c.pose.position.z = 1.5 + 0.2 * math.sin(((i % 71) + phase) * 0.3)
            c.color.r, c.color.g, c.color.b = hue, 1.0 - hue, 0.5
        for m in demo:
            m.header.stamp = stamp
        self.markers_pub.publish(MarkerArray(markers=demo + self.cubes))

        single = marker('single', 1, Marker.TEXT_VIEW_FACING, (x, y, 0.8), (0, 0, 0.2), text='robot' if phase % 2 == 0 else 'ROBOT')
        single.header.stamp = stamp
        self.marker_pub.publish(single)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--points', type=int, default=100_000, help='PointCloud2 points per message (default 100000; Rust mock uses 300000)')
    ap.add_argument('--cubes', type=int, default=5_000, help='CUBE markers in /markers (default 5000)')
    ap.add_argument('--livox-points', type=int, default=4_000, help='CustomPoint entries per /livox/lidar message (default 4000)')
    args, ros_args = ap.parse_known_args()
    rclpy.init(args=ros_args)
    node = MockScene(args.points, args.cubes, args.livox_points)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
