# Development / build image: ROS 2 Humble + Rust + wasm-pack + Node 24.
# The host (Ubuntu 20.04) has no ROS 2; r2r needs a sourced ROS environment at
# build time, so the Rust bridge/server are built here.
FROM ros:humble-ros-base

ENV DEBIAN_FRONTEND=noninteractive
ARG UID=1000
ARG GID=1000
ARG NODE_MAJOR=24

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential clang libclang-dev pkg-config \
        curl git ca-certificates gnupg sudo \
        ros-humble-rmw-cyclonedds-cpp \
        ros-humble-map-msgs \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Non-root user matching the host uid so bind-mounted files stay owned by the host user.
RUN groupadd -g ${GID} dev 2>/dev/null || true \
    && useradd -m -u ${UID} -g ${GID} -s /bin/bash dev \
    && echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
# Pre-create every directory that compose mounts as a named volume, owned by
# `dev`; Docker copies the ownership into a fresh volume on first use.
RUN mkdir -p /ws/target && chown -R dev:dev /ws
USER dev
ENV HOME=/home/dev
ENV PATH=${HOME}/.cargo/bin:${PATH}
RUN mkdir -p ${HOME}/.cargo/registry ${HOME}/.cargo/git ${HOME}/.npm

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    && rustup target add wasm32-unknown-unknown \
    && rustup component add clippy rustfmt \
    && cargo install wasm-pack --locked

# livox_ros_driver2/msg/CustomMsg is not in apt. r2r can only subscribe to
# types it generated typesupport for (IDL_PACKAGE_FILTER in compose.yml), so
# build a message-only copy of the upstream package (docker/livox_msgs: the
# .msg files verbatim, same package name → same DDS type name) into
# /opt/livox_ws. The driver node, Livox-SDK2 and PCL are not needed here.
COPY --chown=dev:dev livox_msgs /opt/livox_ws/src/livox_ros_driver2
RUN cd /opt/livox_ws \
    && bash -c 'source /opt/ros/humble/setup.bash && colcon build --merge-install --cmake-args -DCMAKE_BUILD_TYPE=Release' \
    && rm -rf /opt/livox_ws/build /opt/livox_ws/log

ENV RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
WORKDIR /ws

# Source ROS for every command (interactive shells and `run` commands alike).
RUN echo 'source /opt/ros/humble/setup.bash && source /opt/livox_ws/install/setup.bash' >> ${HOME}/.bashrc
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
