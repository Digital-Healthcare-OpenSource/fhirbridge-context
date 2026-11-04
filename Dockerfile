# syntax=docker/dockerfile:1.7
#
# fhirbridge container: CLI + stdio MCP server.
#   docker run --rm -i -v "$PWD:/data" -e FHIRBRIDGE_VAULT_PASSPHRASE ghcr.io/digital-healthcare-opensource/fhirbridge \
#     pack /data/patient.json --vault /data/patient.vault.json
#
# Runtime image: distroless Node 22, non-root (uid 65532), no shell, no package manager.
# Patient data is never baked in; mount it read-only and keep the vault on a separate volume.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && find node_modules -name '*.map' -delete

FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot AS runtime
LABEL org.opencontainers.image.title="fhirbridge" \
      org.opencontainers.image.description="Normalize, de-identify and compile FHIR R4 exports into verified LLM context" \
      org.opencontainers.image.source="https://github.com/Digital-Healthcare-OpenSource/fhirbridge-context" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS="--disable-proto=delete"
COPY --from=prod-deps --chown=nonroot:nonroot /src/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /src/dist ./dist
COPY --chown=nonroot:nonroot package.json LICENSE ./
USER nonroot
WORKDIR /data
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/cli.js"]
CMD ["--help"]
