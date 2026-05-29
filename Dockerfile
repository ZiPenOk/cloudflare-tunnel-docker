FROM cloudflare/cloudflared:latest AS cloudflared

FROM node:20-alpine

RUN apk add --no-cache ca-certificates tini
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV PANEL_HOST=0.0.0.0 \
    PANEL_PORT=18088 \
    METRICS_HOST=127.0.0.1 \
    METRICS_PORT=20241 \
    HEARTBEAT_INTERVAL_MS=10000 \
    HEARTBEAT_TIMEOUT_MS=5000 \
    RESTART_FAILURE_THRESHOLD=3 \
    RESTART_COOLDOWN_MS=30000

EXPOSE ${PANEL_PORT}
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
