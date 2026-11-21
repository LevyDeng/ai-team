FROM ubuntu:20.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       bash ca-certificates curl git libgcc-s1 libstdc++6 ripgrep \
    && rm -rf /var/lib/apt/lists/*

ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid "$USER_GID" claude \
    && useradd --uid "$USER_UID" --gid "$USER_GID" --create-home --shell /bin/bash claude
USER claude
WORKDIR /home/claude
ENV PATH="/home/claude/.local/bin:${PATH}"
ARG CLAUDE_VERSION=stable
RUN curl --fail --silent --show-error --location --retry 3 \
        https://claude.ai/install.sh -o /tmp/claude-install.sh \
    && bash /tmp/claude-install.sh "$CLAUDE_VERSION" \
    && claude --version
# Rebuild the image to update the CLI. Persist login state separately.
ENV DISABLE_AUTOUPDATER=1
ENV WINDOWS_MCP_IN_CONTAINER=1
ENV CLAUDE_CONFIG_DIR=/home/claude/state
WORKDIR /workspace

