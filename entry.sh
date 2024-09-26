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

  containers=$(sudo docker ps | awk '{if(NR>1) print $NF}')

  for container in $containers
  do
    resp=$(docker inspect "$container")
    if [[ "${resp,,}" == *"\"/data:/data\""* ]] ;then
      target="$container"
      break
    fi
  done

fi

if ! docker inspect "$target" &>/dev/null; then
  echo "ERROR: Failed to find container!" && exit 16
fi

resp=$(docker inspect "$target")

if [[ "${resp,,}" != *"umbrel_main_network"* ]] ;then
  if ! docker network connect umbrel_main_network "$target"; then
    echo "ERROR: Failed to connect container to network!" && exit 17
  fi
fi

if [[ "${resp,,}" != *"\"/data:/data\""* ]] ;then
  echo "ERROR: You did not bind the /data:/data folder!" && exit 18
fi

# Create directories
mkdir -p /images
mkdir -p /data/tor/
mkdir -p /data/umbrel-os/home
mkdir -p /data/umbrel-os/var/log

trap "pkill -SIGINT -f umbreld; while pgrep umbreld >/dev/null; do sleep 1; done" SIGINT SIGTERM

umbreld --data-directory /data & wait $!
