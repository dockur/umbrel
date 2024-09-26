FROM scratch AS base

ADD https://github.com/getumbrel/umbrel.git#1.2.2 /

# Apply custom patches
COPY source /packages/umbreld/source

#########################################################################
# ui build stage
#########################################################################

FROM node:18 AS ui-build

# Install pnpm
RUN npm install -g pnpm@8

# Set the working directory
WORKDIR /app

# Copy the package.json and package-lock.json
COPY --from=base packages/ui/ .

# Install the dependencies
RUN rm -rf node_modules || true
RUN pnpm install

# Build the app
RUN pnpm run build

#########################################################################
# backend build stage
#########################################################################

FROM node:18 AS be-build

COPY --from=base packages/umbreld /tmp/umbreld
COPY --from=ui-build /app/dist /tmp/umbreld/ui
WORKDIR /tmp/umbreld

# Install the dependencies
RUN rm -rf node_modules || true
RUN npm install

# Build the app
RUN npm run build -- --native

#########################################################################
# umbrelos build stage
#########################################################################

FROM debian:bookworm-slim AS umbrelos
ENV NODE_ENV=production

ARG TARGETARCH
ARG VERSION_ARG="0.0"
ARG YQ_VERSION="v4.24.5"
ARG DEBCONF_NOWARNINGS="yes"
ARG DEBIAN_FRONTEND="noninteractive"
ARG DEBCONF_NONINTERACTIVE_SEEN="true"

RUN set -eu \
  && apt-get update -y \
  && apt-get --no-install-recommends -y install sudo nano vim less man iproute2 iputils-ping curl wget ca-certificates dmidecode \
  && apt-get --no-install-recommends -y install python3 fswatch jq rsync curl git gettext-base gnupg libnss-mdns procps tini apt-transport-https \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
  && apt-get update -y \
  && apt-get --no-install-recommends -y install docker-ce-cli docker-compose-plugin \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
  && echo "$VERSION_ARG" > /run/version \
  && curl -sLo /usr/local/bin/yq https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${TARGETARCH} \
  && chmod +x /usr/local/bin/yq \
  && adduser --gecos "" --disabled-password umbrel \
  && echo "umbrel:umbrel" | chpasswd \
  && usermod -aG sudo umbrel

# Install umbreld
COPY --chmod=755 ./entry.sh /run/
COPY --from=be-build --chmod=755 /tmp/umbreld/build/umbreld /usr/local/bin/umbreld

VOLUME /data
EXPOSE 80 443

ENTRYPOINT ["/usr/bin/tini", "-s", "/run/entry.sh"]
