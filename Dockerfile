# syntax=docker/dockerfile:1

ARG YQ_VERSION=4.24.5
ARG NODE_VERSION=22.13.0
ARG DEBIAN_VERSION=bookworm

FROM --platform=$BUILDPLATFORM scratch AS base

ARG VERSION_ARG="1.7.4"
ADD https://github.com/getumbrel/umbrel.git#${VERSION_ARG} /

# Apply custom patches
COPY source /packages/umbreld/source

#########################################################################
# ui build stage
#########################################################################

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-${DEBIAN_VERSION} AS ui-build

# Set the working directory
WORKDIR /packages/ui

# Copy ui and umbreld source (ui imports shared types from umbreld)
COPY --from=base packages/ui/ .
COPY --from=base packages/umbreld/source /packages/umbreld/source
COPY --from=base packages/umbreld/source/modules/server/trpc/common.ts /umbreld/source/modules/server/trpc/common.ts

# Install the dependencies
RUN rm -rf node_modules || true
RUN npm ci

# Build the app
RUN npm run build

#########################################################################
# backend build stage
#########################################################################

FROM node:${NODE_VERSION}-${DEBIAN_VERSION} AS be-build

COPY --from=base packages/umbreld /opt/umbreld
COPY --from=ui-build /packages/ui/dist /opt/umbreld/ui
WORKDIR /opt/umbreld
RUN chmod +x /opt/umbreld/source/modules/apps/legacy-compat/app-script

# Install the dependencies
RUN rm -rf node_modules || true

# Build the app
RUN npm clean-install --omit dev && npm link

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
    imagemagick \
    ffmpeg \
    tini

  # Add Docker repository
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list

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

  # Set version file
  echo "$VERSION_ARG" > /etc/version

  # Create umbrel user
  addgroup --gid 1000 umbrel
  adduser --uid 1000 --gid 1000 --gecos "" --disabled-password umbrel
  echo "umbrel:umbrel" | chpasswd
  usermod -aG sudo umbrel
EOF

# Copy Samba configuration
# COPY --chmod=664 ./smb.conf /etc/samba/smb.conf

# Install umbreld
COPY --chmod=755 ./entrypoint.sh /run/entry.sh
COPY --from=be-build --chmod=755 /opt/umbreld /opt/umbreld

VOLUME /data
EXPOSE 80 443

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -LfSs http://localhost:80 >/dev/null && docker info >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/bin/tini", "-s", "/run/entry.sh"]
