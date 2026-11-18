# syntax=docker/dockerfile:1.7
#
# Agent tool runtime.
#
# This is the image an agent shell runs in when a workflow needs git, gh,
# ripgrep, Node/pnpm or the Docker CLI. It is a *tool* image, not an application
# image: it has a shell on purpose, and it is the only place in the stack where
# that is allowed.
#
# What it is not: a privileged container. Docker access comes from the optional
# rootless `dind` sidecar (compose profile `dind`); this image only carries the
# CLI and points `DOCKER_HOST` at that sidecar. Without the profile, `docker`
# commands fail with a clear connection error instead of silently running
# against the host daemon.
#
# Build from the repository root:
#   docker build -f deploy/code-host/tools.Dockerfile -t openchat-tools .

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS runtime

# `gh` is Debian bookworm's package (2.23.0); the GitHub apt repository would
# add an unpinned external source to a build that still has to stay
# reproducible. Rust/Go toolchains are deliberately absent — the agent installs
# what a task needs at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gh \
      jq \
      less \
      openssh-client \
      procps \
      ripgrep \
      sqlite3 \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI only, from the static release tarball: the Debian `docker.io`
# package would drag in a daemon and containerd into the tool image. The static
# download host publishes a per-release `<tarball>.sha256` sidecar next to the
# tarball; it is fetched from the same base URL and verified before unpacking,
# so a swapped or truncated download fails the build.
#
# 29.10.0 is the current stable release and the one that publishes that sidecar;
# bump the version and the checksum source together.
ARG DOCKER_CLI_VERSION=29.10.0
# Release builds target amd64 and arm64; buildx exposes the target as
# TARGETARCH and the static tarball uses its own arch names.
ARG TARGETARCH=amd64
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="https://download.docker.com/linux/static/stable/${arch}"; \
    tarball="docker-${DOCKER_CLI_VERSION}.tgz"; \
    work=$(mktemp -d); \
    curl -fsSLo "$work/${tarball}" "$base/${tarball}"; \
    curl -fsSLo "$work/${tarball}.sha256" "$base/${tarball}.sha256"; \
    ( cd "$work" && sha256sum -c "${tarball}.sha256" ); \
    tar -xz --strip-components=1 -C /usr/local/bin docker/docker < "$work/${tarball}"; \
    rm -rf "$work"; \
    docker --version

RUN npm install --global pnpm@11.23.0 \
 && pnpm --version \
 && git --version \
 && rg --version | head -1 \
 && gh --version | head -1

# The tool container joins the rootless dind sidecar's private network. Plain
# TCP is acceptable there: the network is not published and has no route from
# the edge. A host-side remote (DOCKER_HOST from the environment) still wins.
ENV DOCKER_HOST=tcp://dind:2375 \
    WORKDIR=/workspace

WORKDIR /workspace
# Same uid as the BFF and the OpenCode container use; the workspace volume is
# shared, so differing owners would make agent output unreadable elsewhere.
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD ["git", "--version"]
