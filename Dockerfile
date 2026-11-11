# syntax=docker/dockerfile:1
# Morphix headless server. Multi-arch (linux/amd64, linux/arm64, linux/arm/v7):
#   docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 -t morphix .
# Options: --build-arg WITH_PRUSASLICER=1 (adds Debian's PrusaSlicer, ~400 MB)
#          --build-arg RUN_TESTS=1       (runs the test suite during the build)
# Run: docker compose up -d   (see docker-compose.yml and docs/INSTALL.md)
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG RUN_TESTS=0
RUN if [ "$RUN_TESTS" = 1 ]; then npm test; fi
RUN npm run build && npm run build:server && test -f apps/server/dist/server.cjs \
 && npm prune --omit=dev

FROM ${NODE_IMAGE}
ARG WITH_PRUSASLICER=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates $(if [ "$WITH_PRUSASLICER" = 1 ]; then echo prusa-slicer; fi) \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system morphix \
 && useradd --system --gid morphix --groups dialout,video --home-dir /data --shell /usr/sbin/nologin morphix \
 && install -d -m 0700 -o morphix -g morphix /data
WORKDIR /app
COPY --from=build --chown=root:root /src/package.json ./
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /src/apps ./apps
COPY --from=build --chown=root:root /src/packages ./packages
COPY --from=build --chown=root:root /src/config ./config
ENV NODE_ENV=production \
    MORPHIX_DATA_DIR=/data \
    MORPHIX_ROOT=/data \
    MORPHIX_PORT=8080 \
    MORPHIX_BIND=0.0.0.0 \
    HOME=/data
USER morphix
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MORPHIX_PORT||8080)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>r.json()).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/server/dist/server.cjs"]
