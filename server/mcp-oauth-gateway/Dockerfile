FROM node:22-alpine

WORKDIR /app
COPY gateway.cjs /app/gateway.cjs

ENV LISTEN_HOST=127.0.0.1
ENV LISTEN_PORT=18080
ENV STATE_FILE=/data/oauth-state.json
ENV TUNNEL_ENV_FILE=/run/windows-mcp/tunnel.env
ENV DIRECTORY_ACCESS_ENABLED=1

USER node
CMD ["node", "/app/gateway.cjs"]
