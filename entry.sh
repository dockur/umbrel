#!/usr/bin/env bash
set -Eeuo pipefail

if [ ! -S /var/run/docker.sock ]; then
  echo "ERROR: Docker socket is missing? Please bind /var/run/docker.sock in your compose file." && exit 13
fi

if ! docker network inspect umbrel_main_network &>/dev/null; then
  if ! docker network create --driver=bridge --subnet="10.21.0.0/16" umbrel_main_network >/dev/null; then
    echo "ERROR: Failed to create network 'umbrel_main_network'!" && exit 14
  fi
  if ! docker network inspect umbrel_main_network &>/dev/null; then
    echo "ERROR: Network 'umbrel_main_network' does not exist?" && exit 15
  fi
fi

target=$(hostname)

if ! docker inspect "$target" &>/dev/null; then
  echo "ERROR: Failed to find a container with name '$target'!" && exit 16
fi

resp=$(docker inspect "$target")
network=$(echo "$resp" | jq -r '.[0].NetworkSettings.Networks["umbrel_main_network"]')

if [ -z "$network" ] || [[ "$network" == "null" ]]; then
  if ! docker network connect umbrel_main_network "$target"; then
    echo "ERROR: Failed to connect container to network!" && exit 17
  fi
fi

mount=$(echo "$resp" | jq -r '.[0].Mounts[] | select(.Destination == "/data").Source')

if [ -z "$mount" ] || [[ "$mount" == "null" ]]; then
  echo "ERROR: You did not bind the /data folder!" && exit 18
fi

# Create directories
mkdir -p "/images"
mkdir -p "$mount/tor"

trap "pkill -SIGINT -f umbreld; while pgrep umbreld >/dev/null; do sleep 1; done" SIGINT SIGTERM

umbreld --data-directory "$mount" & wait $!
