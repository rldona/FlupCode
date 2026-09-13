# Build from the repository root:
#   docker build -f packages/relay/Dockerfile -t flupcode-relay .
FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app
COPY packages/remote/src packages/remote/src
COPY packages/remote/package.json packages/remote/package.json
COPY packages/relay/src packages/relay/src
COPY packages/relay/package.json packages/relay/package.json

# The relay has no npm dependencies: link the workspace package and bundle into one file.
RUN mkdir -p packages/relay/node_modules/@flupcode \
  && ln -s ../../../remote packages/relay/node_modules/@flupcode/remote \
  && bun build packages/relay/src/index.ts --target=bun --outfile /out/relay.js

FROM oven/bun:1.3.14-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/relay.js ./relay.js
USER bun
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8787}/health || exit 1
CMD ["bun", "relay.js"]
