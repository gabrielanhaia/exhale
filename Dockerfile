# Exhale engine + web UI, for running locally without Electron.
# The SmartSpectra native runtime needs glibc >= 2.35: bookworm has 2.36.
FROM node:24-bookworm-slim

# The SDK talks to Presage over TLS (key check, model download).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Production deps only (no Electron / Playwright), then drop the native
# runtimes for the other operating systems.
RUN npm ci --omit=dev --ignore-scripts \
 && rm -rf node_modules/@smartspectra/node-sdk-darwin-* node_modules/@smartspectra/node-sdk-win32-* \
 && npm cache clean --force

COPY bin ./bin
COPY src ./src

ENV EXHALE_HOST=0.0.0.0 \
    EXHALE_PORT=7777 \
    EXHALE_DATA_DIR=/data \
    NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7777
CMD ["node", "bin/exhale.js", "serve"]
