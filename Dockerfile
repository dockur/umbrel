# syntax=docker/dockerfile:1

ARG YQ_VERSION=4.24.5
ARG NODE_VERSION=22.13.0
ARG DEBIAN_VERSION=trixie
ARG RCLONE_VERSION=1.75.1

# Watchman is pinned to the same Homebrew bottle as umbrelOS
ARG WATCHMAN_VERSION=2026.05.11.00
ARG HOMEBREW_BREW_COMMIT=76ca8d74e4a180badad438bf245ddfc740d68a8e
ARG WATCHMAN_HOMEBREW_CORE_COMMIT=a33d7e6eed67d79d55b3d45050c6f45646116393

#########################################################################
# source stage: upstream umbrelOS with the Docker patches applied
#########################################################################

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm AS base

ARG VERSION_ARG="2.0.0"
ADD https://github.com/getumbrel/umbrel.git#${VERSION_ARG} /src

# Apply custom patches (fails loudly when upstream changed underneath them)
COPY patches /patches
WORKDIR /src
RUN git apply --verbose /patches/*.patch

#########################################################################
# ui build stage
#########################################################################

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS ui-build

# Set the working directory
WORKDIR /app

# Copy ui and the umbreld files it imports runtime values from
COPY --from=base /src/packages/ui/ .
COPY --from=base /src/packages/umbreld/source/modules/server/trpc/common.ts /umbreld/source/modules/server/trpc/common.ts
COPY --from=base /src/packages/umbreld/source/modules/user/wallpapers.ts /umbreld/source/modules/user/wallpapers.ts
COPY --from=base /src/packages/umbreld/source/modules/machines/input-motion.ts /umbreld/source/modules/machines/input-motion.ts

# Install the dependencies
RUN rm -rf node_modules || true
RUN npm ci

# Build the dashboard and app-auth frontend
RUN npm run build

#########################################################################
# typecheck stage (optional: docker build --target typecheck .)
#########################################################################

FROM node:${NODE_VERSION}-bookworm AS typecheck

COPY --from=base /src/packages/umbreld /opt/umbreld
WORKDIR /opt/umbreld
RUN npm ci && npm run typecheck

#########################################################################
# backend build stage
#########################################################################

FROM node:${NODE_VERSION}-bookworm AS be-build

COPY --from=base /src/packages/umbreld /opt/umbreld
COPY --from=ui-build /app/dist /opt/umbreld/ui
WORKDIR /opt/umbreld
RUN chmod +x /opt/umbreld/source/modules/apps/legacy-compat/app-script

# Install the dependencies
RUN rm -rf node_modules || true

# Build the app
RUN npm clean-install --omit dev && npm link

#########################################################################
# watchman build stage
#########################################################################

# umbrelOS 2.0 subscribes to file changes through Watchman to work around a
# Parcel watcher bug (https://github.com/getumbrel/umbrel/issues/2158).
# Homebrew provides prebuilt bottles for both amd64 and arm64.
FROM debian:${DEBIAN_VERSION}-slim AS watchman-build

ARG WATCHMAN_VERSION
ARG HOMEBREW_BREW_COMMIT
ARG WATCHMAN_HOMEBREW_CORE_COMMIT
ARG DEBIAN_FRONTEND="noninteractive"

RUN apt-get update -y && \
    apt-get install --no-install-recommends -y ca-certificates curl git file patchelf procps && \
    rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash linuxbrew && \
    mkdir -p /home/linuxbrew/.linuxbrew && \
    chown -R linuxbrew:linuxbrew /home/linuxbrew

USER linuxbrew

ENV HOME=/home/linuxbrew
ENV HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew
ENV HOMEBREW_CELLAR=/home/linuxbrew/.linuxbrew/Cellar
ENV HOMEBREW_REPOSITORY=/home/linuxbrew/.linuxbrew/Homebrew
ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}
ENV HOMEBREW_NO_ANALYTICS=1
ENV HOMEBREW_NO_AUTO_UPDATE=1
ENV HOMEBREW_NO_ENV_HINTS=1
ENV HOMEBREW_NO_INSTALL_CLEANUP=1
ENV HOMEBREW_NO_INSTALL_FROM_API=1

RUN git init "${HOMEBREW_REPOSITORY}" && \
    git -C "${HOMEBREW_REPOSITORY}" remote add origin https://github.com/Homebrew/brew.git && \
    git -C "${HOMEBREW_REPOSITORY}" fetch --depth=1 origin "${HOMEBREW_BREW_COMMIT}" && \
    git -C "${HOMEBREW_REPOSITORY}" checkout --detach FETCH_HEAD && \
    mkdir -p \
        "${HOMEBREW_PREFIX}/bin" \
        "${HOMEBREW_PREFIX}/etc" \
        "${HOMEBREW_PREFIX}/include" \
        "${HOMEBREW_PREFIX}/lib" \
        "${HOMEBREW_PREFIX}/opt" \
        "${HOMEBREW_PREFIX}/sbin" \
        "${HOMEBREW_PREFIX}/share" \
        "${HOMEBREW_PREFIX}/var/homebrew" && \
    ln -s ../Homebrew/bin/brew "${HOMEBREW_PREFIX}/bin/brew"

RUN mkdir -p "${HOMEBREW_REPOSITORY}/Library/Taps/homebrew/homebrew-core" && \
    git -C "${HOMEBREW_REPOSITORY}/Library/Taps/homebrew/homebrew-core" init && \
    git -C "${HOMEBREW_REPOSITORY}/Library/Taps/homebrew/homebrew-core" remote add origin https://github.com/Homebrew/homebrew-core.git && \
    git -C "${HOMEBREW_REPOSITORY}/Library/Taps/homebrew/homebrew-core" fetch --depth=1 origin "${WATCHMAN_HOMEBREW_CORE_COMMIT}" && \
    git -C "${HOMEBREW_REPOSITORY}/Library/Taps/homebrew/homebrew-core" checkout --detach FETCH_HEAD

RUN brew install --formula --force-bottle watchman && \
    test "$(watchman -v)" = "${WATCHMAN_VERSION}" && \
    brew cleanup --prune=all

# Build-only stage: only /opt/linuxbrew is copied into the final image
# hadolint ignore=DL3002
USER root

# Relocate the Homebrew prefix so it no longer depends on the build user's home
RUN cp -a /home/linuxbrew/.linuxbrew /opt/linuxbrew && \
    grep -Z -a -r -l "/home/linuxbrew/.linuxbrew" /opt/linuxbrew | xargs -0 -r sh -c ' \
        for file do \
            if patchelf --print-interpreter "$file" >/dev/null 2>&1; then \
                patchelf --set-interpreter /opt/linuxbrew/lib/ld.so "$file"; \
            fi; \
            rpath="$(patchelf --print-rpath "$file" 2>/dev/null || true)"; \
            if printf "%s" "$rpath" | grep -q "/home/linuxbrew/.linuxbrew"; then \
                patchelf --set-rpath "$(printf "%s" "$rpath" | sed "s#/home/linuxbrew/.linuxbrew#/opt/linuxbrew#g")" "$file"; \
            fi; \
        done \
    ' sh && \
    mv /home/linuxbrew /home/linuxbrew.build-only && \
    /opt/linuxbrew/bin/watchman -v

#########################################################################
# umbrelos build stage
#########################################################################

FROM debian:${DEBIAN_VERSION}-slim AS umbrelos

# Docker API version compatibility - ensures SDK works with newer Docker daemons
ENV DOCKER_API_VERSION=1.44
ENV NODE_ENV=production

# We need to duplicate this such that we can also use the argument below.
ARG TARGETARCH
ARG YQ_VERSION
ARG NODE_VERSION
ARG RCLONE_VERSION

ARG VERSION_ARG="0.0"
ARG DEBCONF_NOWARNINGS="yes"
ARG DEBIAN_FRONTEND="noninteractive"
ARG DEBCONF_NONINTERACTIVE_SEEN="true"

RUN <<EOF
  set -eu

  apt-get update -y
  apt-get --no-install-recommends -y install \
    sudo \
    nano \
    vim \
    less \
    man \
    iproute2 \
    iputils-ping \
    curl \
    wget \
    cifs-utils \
    ca-certificates \
    whois \
    e2fsprogs \
    procps \
    python3 \
    fswatch \
    jq \
    rsync \
    git \
    gettext-base \
    gnupg \
    libnss-mdns \
    p7zip-full \
    unar \
    openssl \
    imagemagick \
    libheif-plugin-libde265 \
    libimage-exiftool-perl \
    ffmpeg \
    tini

  # Add Docker repository
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian trixie stable" > /etc/apt/sources.list.d/docker.list

  # Install Docker client
  apt-get update -y
  apt-get --no-install-recommends -y install \
    docker-ce-cli \
    docker-compose-plugin

  apt-get clean
  rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

  # Install Node.js
  NODE_ARCH=$([ "${TARGETARCH}" = "arm64" ] && echo "arm64" || echo "x64")
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o node.tar.gz
  tar -xz -f node.tar.gz -C /usr/local --strip-components=1
  rm -rf node.tar.gz

  # Install yq
  curl -fsLo /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${TARGETARCH}"
  chmod +x /usr/local/bin/yq

  # Install the rclone release used by Cloud
  curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}.zip" -o /tmp/rclone.zip
  python3 -m zipfile -e /tmp/rclone.zip /tmp/rclone
  mv "/tmp/rclone/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}/rclone" /usr/bin/rclone
  chmod +x /usr/bin/rclone
  rm -rf /tmp/rclone /tmp/rclone.zip

  # Set version file
  echo "$VERSION_ARG" > /etc/version

  # Create umbrel user
  addgroup --gid 1000 umbrel
  adduser --uid 1000 --gid 1000 --gecos "" --disabled-password umbrel
  echo "umbrel:umbrel" | chpasswd
  usermod -aG sudo umbrel
EOF

# Install the virtualization stack used by Umbrel Machines, mirroring umbrelOS
# (packages/os/umbrelos.Dockerfile) without the audio packages. amd64 hosts
# only run x86 machines, so the ARM emulator and firmware are limited to arm64.
# The OpenGL module and Mesa provide virgl 3D graphics, which the Android
# machine (Waydroid) needs: on the host GPU when its render node is usable,
# otherwise rendered in software by llvmpipe (Docker Desktop).
RUN <<EOF
  set -eu

  arm_packages=""
  if [ "${TARGETARCH}" = "arm64" ]; then
    arm_packages="qemu-system-arm qemu-efi-aarch64"
  fi

  apt-get update -y
  # shellcheck disable=SC2086
  apt-get --no-install-recommends -y install $arm_packages \
    libvirt-daemon-system \
    libvirt-daemon-driver-qemu \
    libvirt-daemon-lock \
    libvirt-clients \
    qemu-system-x86 \
    qemu-system-modules-opengl \
    libegl1 \
    libegl-mesa0 \
    libgl1-mesa-dri \
    libgbm1 \
    qemu-utils \
    ovmf \
    seabios \
    swtpm \
    swtpm-tools \
    dnsmasq-base \
    nftables \
    cloud-image-utils \
    libarchive-tools \
    xorriso \
    genisoimage \
    dosfstools \
    mtools \
    wimtools
  apt-get clean
  rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

  # Same libvirt configuration as umbrelOS: native nftables backend, no default
  # network, and the devices QEMU may open inside its mount namespace.
  sed -i 's/^#firewall_backend = "iptables"/firewall_backend = "nftables"/' /etc/libvirt/network.conf
  grep -Fqx 'firewall_backend = "nftables"' /etc/libvirt/network.conf
  rm -f /etc/libvirt/qemu/networks/default.xml /etc/libvirt/qemu/networks/autostart/default.xml
  echo 'cgroup_device_acl = [ "/dev/null", "/dev/full", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/ptmx", "/dev/kvm", "/dev/userfaultfd" ]' >> /etc/libvirt/qemu.conf
  usermod -aG umbrel libvirt-qemu

  # libvirt's nftables backend fixes DHCP checksums with an htb qdisc. Kernels
  # without htb (Docker Desktop's WSL2 kernel) reject it, which would prevent
  # the machine network from starting. Modern DHCP clients do not need the fix.
  dpkg-divert --quiet --local --rename --add /usr/sbin/tc
  cat > /usr/sbin/tc <<'TC'
#!/bin/sh
errors=$(mktemp)
/usr/sbin/tc.distrib "$@" 2>"$errors"
rc=$?
if [ "$rc" -ne 0 ] && grep -qE "qdisc kind is unknown|Parent Qdisc doesn't exists" "$errors"; then
  rc=0
else
  cat "$errors" >&2
fi
rm -f "$errors"
exit "$rc"
TC
  chmod +x /usr/sbin/tc
EOF

# Install Watchman
COPY --from=watchman-build --chown=root:root /opt/linuxbrew/ /opt/linuxbrew/
RUN ln -sf /opt/linuxbrew/bin/watchman /usr/local/bin/watchman && \
    mkdir -p /usr/local/var/run/watchman && \
    chmod 2777 /usr/local/var/run/watchman && \
    watchman -v

# Install umbreld
COPY --chmod=755 ./entrypoint.sh /run/entry.sh
COPY --from=be-build --chmod=755 /opt/umbreld /opt/umbreld

VOLUME /data
EXPOSE 80 443 2000

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD ["sh", "-c", "curl -LfSs http://localhost:80 >/dev/null && docker info >/dev/null 2>&1"]

ENTRYPOINT ["/usr/bin/tini", "-s", "/run/entry.sh"]
