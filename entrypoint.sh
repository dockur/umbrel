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

checkEnvironment() {

  if [ ! -S /var/run/docker.sock ]; then
    error "Docker socket is missing? Please bind /var/run/docker.sock in your compose file." && exit 13
  fi

  return 0
}

checkDocker() {

  if ! docker info >/dev/null 2>&1; then
    error "Failed to connect to the Docker daemon through /var/run/docker.sock." && exit 25
  fi

  if ! docker compose version >/dev/null 2>&1; then
    error "Docker Compose is not available. Please install the Docker Compose plugin." && exit 26
  fi

  return 0
}

configureNetwork() {

  local current_gateway=""
  local current_subnet=""
  local network_json=""

  if network_json=$(docker network inspect "$net" 2>/dev/null); then
    current_subnet=$(
      jq -r \
        --arg subnet "$subnet" \
        'first(.[0].IPAM.Config[]? | select(.Subnet == $subnet) | .Subnet) // ""' \
        <<<"$network_json"
    )

    if [ -n "$current_subnet" ]; then
      current_gateway=$(
        jq -r \
          --arg subnet "$subnet" \
          'first(.[0].IPAM.Config[]? | select(.Subnet == $subnet) | .Gateway) // ""' \
          <<<"$network_json"
      )
    else
      current_subnet=$(jq -r '.[0].IPAM.Config[0].Subnet // ""' <<<"$network_json")
      current_gateway=$(jq -r '.[0].IPAM.Config[0].Gateway // ""' <<<"$network_json")
    fi
  fi

  if [ -n "$current_subnet" ] && [ "$current_subnet" != "$subnet" ]; then
    error "Bridge network '$net' already uses subnet $current_subnet instead of the required subnet $subnet." && exit 14
  fi

  if [ -n "$current_subnet" ] && [ "$current_gateway" != "$gateway" ]; then
    error "Bridge network '$net' already uses gateway ${current_gateway:-unknown} instead of the required gateway $gateway." && exit 14
  fi

  if ! docker network inspect "$net" &>/dev/null; then
    if ! docker network create \
      --driver=bridge \
      "--subnet=$subnet" \
      "--gateway=$gateway" \
      "$net" >/dev/null; then
      error "Failed to create bridge network '$net'!" && exit 14
    fi
  fi

  if ! docker network inspect "$net" &>/dev/null; then
    error "Bridge network '$net' does not exist?" && exit 15
  fi

  return 0
}

detectContainerId() {

  cid=$(grep -oE '[0-9a-f]{12,64}' /proc/self/cgroup | head -n1 || :)
  [ -z "$cid" ] && cid=$(grep -m1 "containers" /proc/self/mountinfo | sed -E 's#.*/containers/([^/]+)/.*#\1#') || :

  return 0
}

detectContainerNameFromId() {

  [ -z "$cid" ] && return 0
  name=$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##') || :
  [ -z "$name" ] && name="$cid"

  return 0
}

detectContainerNameFromHostname() {

  [ -n "$name" ] && return 0

  name=$(
    docker ps -q |
    xargs -r docker inspect --format '{{.Name}} {{.Config.Hostname}}' |
    awk -v t="$host" '$2 == t { print substr($1, 2); exit }'
  ) || :

  [ -z "$name" ] && name="$host"

  return 0
}

detectContainerName() {

  # Determine container name
  detectContainerId
  detectContainerNameFromId
  detectContainerNameFromHostname

  # Check if container name is valid
  if ! docker inspect "$name" &>/dev/null; then
    error "Failed to find a container with name $name!" && exit 16
  fi

  export UMBREL_CONTAINER_NAME="$name"

  return 0
}

inspectContainer() {

  # Inspect the container
  resp=$(docker inspect "$name") || {
    error "Failed to inspect container $name!" && exit 16
  }

  return 0
}

imageRepository() {

  local image="${1%%@*}"

  # Remove the tag from the final path component while preserving a registry port
  sed -E 's#:[^/:]+$##' <<<"$image"

  return 0
}

checkOtherInstance() {

  local container=""
  local container_image=""
  local container_name=""
  local container_repo=""
  local current_image=""
  local current_repo=""
  local other=""

  current_image=$(jq -r '.[0].Config.Image // ""' <<<"$resp")
  current_repo=$(imageRepository "$current_image")

  while read -r container; do
    [ -z "$container" ] && continue

    container_name=$(docker inspect -f '{{.Name}}' "$container" 2>/dev/null | sed 's#^/##') || continue
    [ "$container_name" = "$name" ] && continue

    container_image=$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null) || continue
    container_repo=$(imageRepository "$container_image")

    if [ -n "$current_repo" ] && [ "$container_repo" = "$current_repo" ]; then
      other="$container_name"
      break
    fi
  done < <(docker ps -q)

  if [ -n "$other" ]; then
    error "Another Umbrel container is already running: $other" && exit 23
  fi

  return 0
}

checkPidMode() {

  local pid_mode

  pid_mode=$(jq -r '.[0].HostConfig.PidMode // ""' <<<"$resp")

  if [ "$pid_mode" != "host" ]; then
    error "Host PID mode is required. Please add 'pid: host' to your compose file." && exit 24
  fi

  return 0
}

connectNetwork() {

  local network

  # Connect to bridge network
  network=$(echo "$resp" | jq -r ".[0].NetworkSettings.Networks[\"$net\"]")

  if [ -z "$network" ] || [[ "$network" == "null" ]]; then
    if ! docker network connect "$net" "$name"; then
      error "Failed to connect container to bridge network '$net'!" && exit 17
    fi
  fi

  return 0
}

detectDataMount() {

  mount=$(echo "$resp" | jq -r '.[0].Mounts[] | select(.Destination == "/data").Source')

  if [ -z "$mount" ] || [[ "$mount" == "null" ]] || [ ! -d "/data" ]; then
    error "You did not bind the /data folder!" && exit 18
  fi

  return 0
}

checkDataPermissions() {

  local test_file="/data/.umbrel-write-test.$$"

  # Verify that the main Umbrel process can write to the data folder
  if ! (umask 077 && : > "$test_file") 2>/dev/null; then
    error "The /data folder is not writable!" && exit 22
  fi

  rm -f "$test_file"

  # Warn when the default Umbrel user cannot write to the data folder
  if ! sudo -u umbrel -- sh -c '
    umask 077
    : > "$1"
    rm -f "$1"
  ' sh "$test_file" 2>/dev/null; then
    warn "The /data folder is not writable by user umbrel (UID 1000). Some apps may have permission issues."
  fi

  rm -f "$test_file"

  return 0
}

normalizeMountPath() {

  # Convert Windows paths to Linux path
  if [[ "$mount" == *":\\"* ]]; then
    mount="${mount,,}"
    mount="${mount//\\//}"
    mount="//${mount/:/}"
  fi

  if [[ "$mount" != "/"* ]]; then
    error "Please bind the /data folder to an absolute path!" && exit 19
  fi

  return 0
}

mirrorDataMount() {

  # Mirror external folder to local filesystem
  if [[ "$mount" == "/data" ]]; then
    return 0
  fi

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

  return 0
}

prepareDirectories() {

  # Create directories
  mkdir -p "/images"
  mkdir -p "$mount/tor/data"
  chmod -R 700 "$mount/tor/data" &>/dev/null || :

  return 0
}

checkEnvironment
checkDocker

cid=""
name=""
host=$(hostname -s)
net="umbrel_main_network"
subnet="10.21.0.0/16"
gateway="10.21.0.1"

detectContainerName
inspectContainer
checkOtherInstance
checkPidMode
configureNetwork
connectNetwork
detectDataMount
checkDataPermissions
normalizeMountPath
mirrorDataMount
prepareDirectories

trap - ERR
cd /opt/umbreld

exec ./umbreld --data-directory "$mount" --log-level normal
