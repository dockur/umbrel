#!/usr/bin/env bash
set -Eeuo pipefail

if [ ! -S /var/run/docker.sock ]; then
  echo "ERROR: Docker socket is missing? Please bind /var/run/docker.sock in your compose file." && exit 13
fi

if ! docker network inspect umbrel_main_network; then
  echo "ERROR: Network 'umbrel_main_network' does not exist? Please check your compose file." && exit 14
fi

# Create directories
mkdir -p /images
mkdir -p /data/tor/
mkdir -p /data/umbrel-os/home
mkdir -p /data/umbrel-os/var/log

trap "pkill -SIGINT -f umbreld; while pgrep umbreld >/dev/null; do sleep 1; done" SIGINT SIGTERM

umbreld --data-directory /data & wait $!
