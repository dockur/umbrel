<h1 align="center">umbrelOS<br />
<div align="center">
<a href="https://github.com/dockur/umbrel"><img src="https://raw.githubusercontent.com/dockur/umbrel/master/.github/screen.png" title="Logo" style="max-width:100%;" width="256" /></a>
</div>
<div align="center">

[![Build]][build_url]
[![Version]][tag_url]
[![Size]][tag_url]
[![Package]][pkg_url]
[![Pulls]][hub_url]

</div></h1>

Docker container of [umbrelOS](https://github.com/getumbrel/umbrel), making it possible to run it on any system instead of needing a dedicated device.

## Features ✨

* Does not need dedicated hardware or a virtual machine!

## Usage  🐳

Via Docker Compose:

```yaml
services:
  umbrel:
    image: dockurr/umbrel
    container_name: umbrel
    hostname: umbrel
    ports:
      - 80:80
    volumes:
      - "/home/example:/data"
      - "/var/run/docker.sock:/var/run/docker.sock"
    stop_grace_period: 1m
```

Via Docker CLI:

```bash
docker run -it --rm -p 80:80 -h umbrel -v /home/example:/data -v /var/run/docker.sock:/var/run/docker.sock --stop-timeout 60 dockurr/umbrel
```

## Stars 🌟
[![Stars](https://starchart.cc/dockur/umbrel.svg?variant=adaptive)](https://starchart.cc/dockur/umbrel)

[build_url]: https://github.com/dockur/umbrel/
[hub_url]: https://hub.docker.com/r/dockurr/umbrel
[tag_url]: https://hub.docker.com/r/dockurr/umbrel/tags
[pkg_url]: https://github.com/dockur/umbrel/pkgs/container/umbrel

[Build]: https://github.com/dockur/umbrel/actions/workflows/build.yml/badge.svg
[Size]: https://img.shields.io/docker/image-size/dockurr/umbrel/latest?color=066da5&label=size
[Pulls]: https://img.shields.io/docker/pulls/dockurr/umbrel.svg?style=flat&label=pulls&logo=docker
[Version]: https://img.shields.io/docker/v/dockurr/umbrel/latest?arch=amd64&sort=semver&color=066da5
[Package]:https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fipitio.github.io%2Fbackage%2Fdockur%2Fumbrel%2Fumbrel.json&query=%24.downloads&logo=github&style=flat&color=066da5&label=pulls
