#!/bin/bash
set -e
source /opt/ros/humble/setup.bash
# Livox messages (livox_ros_driver2/msg/CustomMsg), built in the Dockerfile.
source /opt/livox_ws/install/setup.bash
exec "$@"
