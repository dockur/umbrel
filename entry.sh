#!/usr/bin/env bash
set -Eeuo pipefail

info () { printf "%b%s%b" "\E[1;34m❯ \E[1;36m" "${1:-}" "\E[0m\n"; }
error () { printf "%b%s%b" "\E[1;31m❯ " "ERROR: ${1:-}" "\E[0m\n" >&2; }
warn () { printf "%b%s%b" "\E[1;31m❯ " "Warning: ${1:-}" "\E[0m\n" >&2; }

trap 'error "Status $? while: $BASH_COMMAND (line $LINENO/$BASH_LINENO)"' ERR

[ ! -f "/run/entry.sh" ] && error "Script must run inside Docker container!" && exit 11
[ "$(id -u)" -ne "0" ] && error "Script must be executed with root privileges." && exit 12

echo "❯ Starting Umbrel for Docker v$(</run/version)..."
echo "❯ For support visit https://github.com/dockur/umbrel/issues"

if [ ! -S /var/run/docker.sock ]; then
  error "Docker socket is missing?" && exit  13
fi

# Create directories
mkdir -p /images
mkdir -p /data/tor
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
