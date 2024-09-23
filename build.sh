#!/usr/bin/env bash
set -euo pipefail

UMBREL_VERSION="1.2.1"
PNPM_VERSION="8.9.2"
TOR_VERSION="sha256:2ace83f22501f58857fa9b403009f595137fa2e7986c4fda79d82a8119072b6a"
AUTH_VERSION="sha256:b4a4b37896911a85fb74fa159e010129abd9dff751a40ef82f724ae066db3c2a"

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

step_0() {
    if cat /etc/fstab | grep -E "/data/? "; then
	sleep 0
    else
	echo "/data mount not found in fstab"
	echo "You should have a separate partition for /data. It is where all your Umbrel's data will be stored"
	echo "Add /data to fstab, mount it and then rerun the script"
	exit 1
    fi

}

step_1() {
    echo STEP 1/8: Cloning the umbrel repo
    
    git clone https://github.com/getumbrel/umbrel /tmp/umbrel

    pushd /tmp/umbrel
    git checkout -q "$UMBREL_VERSION"
    echo "Checked out Umbrel v$UMBREL_VERSION"
    popd
}

step_2() {
    echo STEP 2/8: Installing the dependencies

    # Update apt sources
cat > /tmp/non-free.list<<EOF
deb http://deb.debian.org/debian bookworm main non-free-firmware
deb-src http://deb.debian.org/debian bookworm main non-free-firmware
deb http://deb.debian.org/debian-security bookworm-security main non-free-firmware
deb-src http://deb.debian.org/debian-security bookworm-security main non-free-firmware
deb http://deb.debian.org/debian bookworm-updates main non-free-firmware
deb-src http://deb.debian.org/debian bookworm-updates main non-free-firmware
EOF
    
    sudo cp /tmp/non-free.list /etc/apt/sources.list

    sudo apt-get update --yes

    # Installing curl
    sudo apt-get install --yes curl

    # Installing docker
    curl -fsSL https://get.docker.com | sudo sh

    # Installing other packages
    sudo apt-get install --yes npm sudo nano vim less man iproute2 iputils-ping curl wget ca-certificates dmidecode usbutils python3 fswatch jq rsync git gettext-base gnupg libnss-mdns skopeo

    # Installing pnpm
    sudo npm install -g pnpm@$PNPM_VERSION
}

step_3() {
    echo STEP 3/8: Builing umbreld/ui

    pushd /tmp/umbrel/packages/ui

    rm -rf node_modules || true
    pnpm install
    pnpm run build

    popd
}

step_4() {
    echo STEP 4/8: Adding the umbrel user

    if id umbrel; then
      echo "User umbrel already exists"
    else
      sudo adduser --gecos "" --disabled-password umbrel
      echo "umbrel:umbrel" | sudo chpasswd
    fi
    sudo usermod -aG sudo umbrel
}

step_5() {
    echo STEP 5/8: Cloning umbrel containers
    
    sudo mkdir -p /images
    sudo docker pull getumbrel/tor@$TOR_VERSION
    sudo docker save -o /images/tor.tar getumbrel/tor@$TOR_VERSION

    sudo docker pull getumbrel/auth-server@$AUTH_VERSION
    sudo docker save -o /images/auth.tar getumbrel/auth-server@$AUTH_VERSION
}

step_6() {
    echo STEP 6/8: Installing umbreld

    pushd /tmp/umbrel/packages/umbreld

    mkdir -p ./ui
    cp -r /tmp/umbrel/packages/ui/dist/* ./ui/
    patch source/modules/provision/provision.ts "$SCRIPT_DIR/remove-docker-installation.diff"
    sudo npm install tsconfig
    sudo npm install --omit dev --global

    sudo umbreld provision-os

    popd
}

step_7() {
    echo STEP 7/8 Setting up overlays

    cp /etc/fstab /tmp/fstab.BAK

    sudo cp -r /tmp/umbrel/packages/os/overlay-common/* /
    sudo cp -r /tmp/umbrel/packages/os/overlay-amd64/* /

    echo >> /tmp/fstab.BAK
    cat /etc/fstab >> /tmp/fstab.BAK

    sudo cp /tmp/fstab.BAK /etc/fstab
}

step_8() {
    echo STEP 8/8 Setting up /data

    # TODO: Mount /data

    sudo mkdir -p /data/umbrel-os/var

    echo "/var/log/ -> /data/umbrel-os/var/log/"
    sudo cp -r /var/log /data/umbrel-os/var/

    echo "/home/ -> /data/umbrel-os/home/"
    sudo cp -r /home /data/umbrel-os/

    sudo mount --bind /data/umbrel-os/var/log/ /var/log/
    sudo mount --bind /data/umbrel-os/home/ /home/
}

if [ $# -gt 0 ]; then
    $1
else
    step_0
    step_1
    step_2
    step_3
    step_5
    step_6
    step_7
    step_8

    echo "Starting umbrel.service..."
    sudo systemctl start umbrel

    curl -s 127.0.0.1 > /dev/null

    echo Installation complete!
    echo
    echo Go to:
    echo http://umbrel.local
    echo or
    echo http://$(hostname -I)
fi
