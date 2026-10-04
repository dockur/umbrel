<h1 align="center">umbrelOS<br />
<div align="center">
<a href="https://github.com/dockur/umbrel"><img src="https://raw.githubusercontent.com/dockur/umbrel/master/.github/header.png" title="Logo" style="max-width:100%;" width="256" /></a>
</div>
<div align="center">

[![Build]][build_url]
[![Version]][tag_url]
[![Size]][tag_url]
[![Package]][pkg_url]
[![Pulls]][hub_url]

</div></h1>

Docker container of [Umbrel](https://umbrel.com/umbrelos), an OS for self-hosting.

## Features ✨

- Runs UmbrelOS inside a Docker container
- Does not need dedicated hardware or a virtual machine
- Provides access to the Umbrel web interface
- Supports installing and running Umbrel apps
- Uses the host Docker daemon for app containers
- Runs virtual machines (Umbrel Machines) with libvirt and QEMU

## Usage  🐳

##### Docker Compose:

```yaml
services:
  umbrel:
    image: dockurr/umbrel
    container_name: umbrel
    pid: host
    privileged: true
    ports:
      - 80:80
      - 443:443
      - 2000:2000
    volumes:
      - ./umbrel:/data
      - /var/run/docker.sock:/var/run/docker.sock
    restart: always
    stop_grace_period: 1m
```

##### Docker CLI:

```bash
docker run -it --rm --name umbrel --pid=host --privileged -p 80:80 -p 443:443 -p 2000:2000 -v "${PWD:-.}/umbrel:/data" -v "/var/run/docker.sock:/var/run/docker.sock" --stop-timeout 60 docker.io/dockurr/umbrel
```

##### GitHub Codespaces:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/dockur/umbrel)

## Screenshot 📸

<div align="center">
<a href="https://github.com/dockur/umbrel"><img src="https://raw.githubusercontent.com/dockur/umbrel/master/.github/screen.png" title="Screenshot" style="max-width:100%;" width="256" /></a>
</div>

## FAQ 💬

### How do I change the storage location?

  To change the storage location, include the following bind mount in your compose file:

  ```yaml
  volumes:
    - ./umbrel:/data
  ```

  Replace the example path `./umbrel` with the desired storage folder or named volume.

  If a folder inside it is a symbolic link to another disk (for example `home` pointing to a storage pool), also bind mount the target of the link at the same path:

  ```yaml
  volumes:
    - ./umbrel:/data
    - /mnt/storage:/mnt/storage
  ```

### Do I need `privileged: true`?

  For Machines (virtual machines) it is required: libvirt needs it to create the virtual network and QEMU uses `/dev/kvm`. For hardware acceleration, enable virtualization (Intel VT-x or AMD-V) in the BIOS of the host.

  It is also required for umbrelOS to advertise the host's LAN address. Reading the host interfaces from inside the container needs `CAP_SYS_ADMIN`, and without `privileged: true` the dashboard and the generated certificate fall back to the container's own Docker address (something like `172.17.0.2`), which no LAN client can reach or validate against. Adding `--cap-add SYS_ADMIN` is not enough here, the container has to be fully privileged. Without it umbrelOS otherwise runs normally and hides Machines.

### How do I upgrade from umbrelOS 1.x?

  Stop the container, back up the data folder, then pull the new image and start it again with the same `/data` folder. umbrelOS 2.0 updates the app configurations on its first start, so going back to 1.x requires the backup.

  The container has to be recreated rather than just restarted with the new image: umbrelOS 2.0 requires host PID mode and exits with `Host PID mode is required` when it is missing, so add `pid: host` (and `privileged: true`, see above) to your existing command or compose file. A 1.x container that ran without them will not start on 2.0.

### How do I run CasaOS in a container?

  See [dockur/casa](https://github.com/dockur/casa) for a CasaOS container.

### How do I run ZimaOS in a container?

  See [dockur/zima](https://github.com/dockur/zima) for a ZimaOS container.

## Stars 🌟
[![Stargazers](https://raw.githubusercontent.com/star-stats/stars/refs/heads/data/charts/dockur-umbrel.svg)](https://github.com/dockur/umbrel/stargazers)

[build_url]: https://github.com/dockur/umbrel/
[hub_url]: https://hub.docker.com/r/dockurr/umbrel
[tag_url]: https://hub.docker.com/r/dockurr/umbrel/tags
[pkg_url]: https://github.com/dockur/umbrel/pkgs/container/umbrel

[Build]: https://github.com/dockur/umbrel/actions/workflows/build.yml/badge.svg
[Size]: https://img.shields.io/docker/image-size/dockurr/umbrel/latest?color=066da5&label=size
[Pulls]: https://img.shields.io/docker/pulls/dockurr/umbrel.svg?style=flat&label=pulls&logo=docker
[Version]: https://img.shields.io/docker/v/dockurr/umbrel/latest?arch=amd64&sort=semver&color=066da5
[Package]:https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fipitio.github.io%2Fbackage%2Fdockur%2Fumbrel%2Fumbrel.json&query=%24.downloads&logo=github&style=flat&color=066da5&label=pulls
