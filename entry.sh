#!/usr/bin/env bash
set -Eeuo pipefail

info () { printf "%b%s%b" "\E[1;34m❯ \E[1;36m" "${1:-}" "\E[0m\n"; }
error () { printf "%b%s%b" "\E[1;31m❯ " "ERROR: ${1:-}" "\E[0m\n" >&2; }
warn () { printf "%b%s%b" "\E[1;31m❯ " "Warning: ${1:-}" "\E[0m\n" >&2; }

trap 'error "Status $? while: $BASH_COMMAND (line $LINENO/$BASH_LINENO)"' ERR

[ ! -f "/run/entry.sh" ] && error "Script must run inside Docker container!" && exit 11
[ "$(id -u)" -ne "0" ] && error "Script must be executed with root privileges." && exit 12

echo "❯ Starting umbrelOS for Docker v$(</etc/version)..."
echo "❯ For support visit https://github.com/dockur/umbrel/issues"

if [ ! -S /var/run/docker.sock ]; then
  error "Docker socket is missing? Please bind /var/run/docker.sock in your compose file." && exit 13
fi

cid=""
name=""
host=$(hostname -s)
net="umbrel_main_network"
subnet="${SUBNET:-10.21.0.0/16}"

current_subnet=""

if network_json=$(docker network inspect "$net" 2>/dev/null); then
  current_subnet="$(jq -r '.[0].IPAM.Config[0].Subnet // ""' <<<"$network_json")"
fi

if [ -n "$current_subnet" ] && [ "$current_subnet" != "$subnet" ]; then
  info "Recreating bridge network '$net' because subnet changed from $current_subnet to $subnet..."

  if ! docker network rm "$net" >/dev/null 2>&1; then
    error "Failed to remove bridge network '$net'. Stop containers using it first." && exit 14
  fi
fi

if ! docker network inspect "$net" &>/dev/null; then
  if ! docker network create --driver=bridge "--subnet=$subnet" "$net" >/dev/null; then
    error "Failed to create bridge network '$net'!" && exit 14
  fi
fi

if ! docker network inspect "$net" &>/dev/null; then
  error "Bridge network '$net' does not exist?" && exit 15
fi

# Determine container name
cid=$(grep -oE '[0-9a-f]{12,64}' /proc/self/cgroup | head -n1 || :)
[ -z "$cid" ] && cid=$(grep -m1 "containers" /proc/self/mountinfo | sed -E 's#.*/containers/([^/]+)/.*#\1#') || :

if [ -n "$cid" ]; then
  name=$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##') || :
  [ -z "$name" ] && name="$cid"
fi

if [ -z "$name" ]; then
  name=$(
    docker ps -q |
    xargs -r docker inspect --format '{{.Name}} {{.Config.Hostname}}' |
    awk -v t="$host" '$2 == t { print substr($1, 2); exit }'
  ) || :
  [ -z "$name" ] && name="$host"
fi

# Check if container name is valid
if ! docker inspect "$name" &>/dev/null; then
  error "Failed to find a container with name $name!" && exit 16
fi

# Inspect the container
resp=$(docker inspect "$name") || {
  error "Failed to inspect container $name!" && exit 16
}

# Connect to bridge network
network=$(echo "$resp" | jq -r ".[0].NetworkSettings.Networks[\"$net\"]")

if [ -z "$network" ] || [[ "$network" == "null" ]]; then
  if ! docker network connect "$net" "$name"; then
    error "Failed to connect container to bridge network '$net'!" && exit 17
  fi
fi

mount=$(echo "$resp" | jq -r '.[0].Mounts[] | select(.Destination == "/data").Source')

if [ -z "$mount" ] || [[ "$mount" == "null" ]] || [ ! -d "/data" ]; then
  error "You did not bind the /data folder!" && exit 18
fi

# Convert Windows paths to Linux path
if [[ "$mount" == *":\\"* ]]; then
  mount="${mount,,}"
  mount="${mount//\\//}"
  mount="//${mount/:/}"
fi

if [[ "$mount" != "/"* ]]; then
  error "Please bind the /data folder to an absolute path!" && exit 19
fi

# Mirror external folder to local filesystem
if [[ "$mount" != "/data" ]]; then

  case "$mount" in
    ""|"/"|"/data"|"/proc"|"/sys"|"/dev"|"/run"|"/tmp"|"/var"|"/etc"|"/usr"|"/opt"|"/home")
      error "Refusing to replace unsafe mount path: $mount" && exit 20
      ;;
  esac

  mkdir -p "$(dirname -- "$mount")"

  if [ -e "$mount" ] && [ ! -L "$mount" ]; then
    error "Mount path already exists and is not a symlink: $mount" && exit 21
  fi

  rm -f "$mount"
  ln -s /data "$mount"
fi

# Create directories
mkdir -p "/images"
mkdir -p "$mount/tor/data"
chmod -R 700 "$mount/tor/data" &>/dev/null || :

trap - ERR
cd /opt/umbreld

exec ./umbreld --data-directory "$mount" --log-level normal
