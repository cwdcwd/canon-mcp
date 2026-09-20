# Multi-arch: builds for linux/arm64 (Raspberry Pi 4/5, 64-bit OS) and linux/amd64
FROM node:22-bookworm-slim

# sane-utils: scanimage + the pixma backend that speaks Canon's BJNP protocol
# libsane-common: backend config files, including pixma.conf
RUN apt-get update \
  && apt-get install -y --no-install-recommends sane-utils libsane-common \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    SCAN_OUTPUT_DIR=/scans \
    PORT=3000 \
    HOST=0.0.0.0

RUN mkdir -p /scans && chown node:node /scans
VOLUME ["/scans"]
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["entrypoint"]
CMD ["node", "src/http.ts"]
