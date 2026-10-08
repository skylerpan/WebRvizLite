#!/usr/bin/env python3
"""Publishes the same synthetic scene as the server's `--mock` transport, but
through a real ROS 2 node (rclpy), for testing the r2r bridge path.

Topics: /scan (10 Hz), /tf (30 Hz), /tf_static (latched). Robot drives a 2 m
circle inside an 8 m x 6 m room; the scan is a ray cast against the walls.

Run inside the ROS container:  python3 tools/mock_scan.py
"""
import math
import time

import rclpy
from geometry_msgs.msg import TransformStamped
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import LaserScan
from tf2_msgs.msg import TFMessage

ROOM_HALF_X, ROOM_HALF_Y = 4.0, 3.0
CIRCLE_RADIUS, CIRCLE_PERIOD_S = 2.0, 20.0
BEAMS = 360


def ray_to_walls(x, y, theta):
    dx, dy = math.cos(theta), math.sin(theta)
    best = math.inf
    if abs(dx) > 1e-9:
        best = min(best, ((ROOM_HALF_X if dx > 0 else -ROOM_HALF_X) - x) / dx)
    if abs(dy) > 1e-9:
        best = min(best, ((ROOM_HALF_Y if dy > 0 else -ROOM_HALF_Y) - y) / dy)
    return best


def tf(stamp, parent, child, x, y, z, yaw=0.0):
    t = TransformStamped()
    t.header.stamp = stamp
    t.header.frame_id = parent
    t.child_frame_id = child
    t.transform.translation.x, t.transform.translation.y, t.transform.translation.z = x, y, z
    t.transform.rotation.z = math.sin(yaw / 2)
    t.transform.rotation.w = math.cos(yaw / 2)
    return t


class MockScan(Node):
    def __init__(self):
        super().__init__('mock_scan')
        sensor_qos = QoSProfile(depth=5, reliability=ReliabilityPolicy.BEST_EFFORT)
        self.scan_pub = self.create_publisher(LaserScan, '/scan', sensor_qos)
        self.tf_pub = self.create_publisher(TFMessage, '/tf', 100)
        static_qos = QoSProfile(depth=100, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.tf_static_pub = self.create_publisher(TFMessage, '/tf_static', static_qos)
        self.start = time.monotonic()
        self.tf_static_pub.publish(TFMessage(transforms=[tf(self.get_clock().now().to_msg(), 'base_link', 'laser', 0.2, 0.0, 0.3)]))
        self.create_timer(0.1, self.publish_scan)
        self.create_timer(1 / 30, self.publish_tf)
        self.get_logger().info('publishing /scan 10 Hz, /tf 30 Hz, /tf_static')

    def pose(self):
        a = (time.monotonic() - self.start) / CIRCLE_PERIOD_S * math.tau
        return CIRCLE_RADIUS * math.cos(a), CIRCLE_RADIUS * math.sin(a), a + math.pi / 2

    def publish_scan(self):
        x, y, yaw = self.pose()
        lx, ly = x + 0.2 * math.cos(yaw), y + 0.2 * math.sin(yaw)
        m = LaserScan()
        m.header.stamp = self.get_clock().now().to_msg()
        m.header.frame_id = 'laser'
        m.angle_min, m.angle_max = -math.pi, math.pi
        m.angle_increment = (m.angle_max - m.angle_min) / BEAMS
        m.scan_time, m.range_min, m.range_max = 0.1, 0.05, 12.0
        m.ranges = [ray_to_walls(lx, ly, m.angle_min + (i + 0.5) * m.angle_increment + yaw) for i in range(BEAMS)]
        m.intensities = [100.0 + 50.0 * math.sin(3 * (m.angle_min + i * m.angle_increment + yaw)) for i in range(BEAMS)]
        self.scan_pub.publish(m)

    def publish_tf(self):
        x, y, yaw = self.pose()
        stamp = self.get_clock().now().to_msg()
        self.tf_pub.publish(TFMessage(transforms=[tf(stamp, 'map', 'odom', 0.0, 0.0, 0.0), tf(stamp, 'odom', 'base_link', x, y, 0.0, yaw)]))


def main():
    rclpy.init()
    node = MockScan()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
