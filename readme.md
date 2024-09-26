<h1 align="center">UmbrelOS<br />
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

Docker container of [UmbrelOS](https://umbrel.com/), making it possible to run it everywhere instead of needing a dedicated device.

## Features ✨

* Does not need dedicated hardware or a virtual machine!

## Usage  🐳

Via Docker Compose:

```yaml
services:
  umbrel:
    image: dockurr/umbrel
    container_name: umbrel
    ports:
      - 80:80
    networks:
       - umbrel_main_network
    volumes:
      - "/data:/data"
      - "/var/run/docker.sock:/var/run/docker.sock"
    stop_grace_period: 1m

networks:
  umbrel_main_network:
    ipam:
      driver: default
      config:
        - subnet: '10.21.0.0/16'
```

> [!IMPORTANT]  
> In order for this container to work correctly, it's required that the binded `/data` folder is also called `/data` on your host.
>
> So do NOT modify the line `/data:/data`, you cannot use a custom location unfortunately.

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
