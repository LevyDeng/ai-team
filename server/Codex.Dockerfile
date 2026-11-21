FROM ubuntu:26.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       bash ca-certificates curl git libstdc++6 ripgrep \
    && rm -rf /var/lib/apt/lists/*

ARG USER_UID=1000
ARG USER_GID=1000
RUN groupmod --gid "$USER_GID" --new-name codex ubuntu \
    && usermod --uid "$USER_UID" --gid "$USER_GID" --login codex \
       --home /home/codex --move-home ubuntu
USER codex
WORKDIR /home/codex
ENV PATH="/home/codex/.local/bin:${PATH}"
RUN curl --fail --silent --show-error --location --retry 3 \
        https://chatgpt.com/codex/install.sh -o /tmp/codex-install.sh \
    && sh /tmp/codex-install.sh \
    && codex --version
RUN mkdir -p /home/codex/state

ENV CODEX_HOME=/home/codex/state
WORKDIR /workspace
