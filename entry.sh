#!/usr/bin/env bash
set -Eeuo pipefail

if [ ! -S /var/run/docker.sock ]; then
  echo "ERROR: Docker socket is missing? Please bind /var/run/docker.sock in your compose file." && exit  13
fi

# Create directories
mkdir -p /images
mkdir -p /data/umbrel-os/var

if [ ! -d /data/umbrel-os/home ]; then
  cp -r /home /data/umbrel-os/
fi

ln -s /data/umbrel-os/home/ /home

if [ ! -d /data/umbrel-os/var/log ]; then
  cp -r /var/log /data/umbrel-os/var/
fi

ln -s /data/umbrel-os/var/log/ /var/log

exec umbreld --data-directory /data
