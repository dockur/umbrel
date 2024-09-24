FROM scratch AS base
ADD https://github.com/getumbrel/umbrel.git#1.2.2 /

#########################################################################
# ui build stage
#########################################################################

FROM node:18.19.1-buster-slim AS ui-build

# Install pnpm
RUN npm install -g pnpm@8

# Set the working directory
WORKDIR /app

# Copy the package.json and package-lock.json
COPY --from=base packages/ui/ .

# Install the dependencies
RUN rm -rf node_modules || true
RUN pnpm install

# Build the app
RUN pnpm run build

#########################################################################
# umbrelos build stage
#########################################################################

FROM debian:bookworm AS umbrelos

ARG DEBCONF_NOWARNINGS="yes"
ARG DEBIAN_FRONTEND="noninteractive"
ARG DEBCONF_NONINTERACTIVE_SEEN="true"

# Install essential system utilities
RUN apt-get update -y \
  && apt-get --no-install-recommends -y install sudo nano vim less man iproute2 iputils-ping curl wget ca-certificates dmidecode usbutils avahi-utils skopeo npm \
  && apt-get --no-install-recommends -y install python3 fswatch jq rsync curl git gettext-base python3 gnupg avahi-daemon avahi-discover libnss-mdns procps \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Add Umbrel user
RUN adduser --gecos "" --disabled-password umbrel \
  && echo "umbrel:umbrel" | chpasswd \
  && usermod -aG sudo umbrel

# Preload images
RUN mkdir -p /images
RUN skopeo copy docker://getumbrel/tor@sha256:2ace83f22501f58857fa9b403009f595137fa2e7986c4fda79d82a8119072b6a docker-archive:/images/tor
RUN skopeo copy docker://getumbrel/auth-server@sha256:b4a4b37896911a85fb74fa159e010129abd9dff751a40ef82f724ae066db3c2a docker-archive:/images/auth

# Install umbreld
COPY --from=base packages/umbreld /tmp/umbreld
COPY --from=ui-build /app/dist /tmp/umbreld/ui
WORKDIR /tmp/umbreld
RUN rm -rf node_modules || true
RUN npm install --omit dev --global
RUN rm -rf /tmp/umbreld
WORKDIR /

# Let umbreld provision the system
# RUN umbreld provision-os

# Copy in filesystem overlay
# COPY packages/os/overlay-common /
# COPY "packages/os/overlay-${TARGETARCH}" /

# Move persistant locations to /data to be bind mounted over the OS.
# /data will exist on a seperate partition that survives OS updates.
# This step should always be last so things like /var/log/apt/
# exist while installing packages.
# Migrataing current data is required to not break journald, otherwise
# /var/log/journal will not exist and journald will log to RAM and not
# persist between reboots.
# RUN mkdir -p /data/umbrel-os/var
# RUN mv /var/log     /data/umbrel-os/var/log
# RUN mv /home        /data/umbrel-os/home
