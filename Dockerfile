# syntax=docker/dockerfile:1.7
#
# fhirbridge container: CLI + stdio MCP server.
#   docker run --rm -i -v "$PWD:/data" -e FHIRBRIDGE_VAULT_PASSPHRASE ghcr.io/digital-healthcare-opensource/fhirbridge \
#     pack /data/patient.json --vault /data/patient.vault.json
#
# Runtime image: distroless Node 22, non-root (uid 65532), no shell, no package manager.
# Patient data is never baked in; mount it read-only and keep the vault on a separate volume.

# Base images are pinned by digest for reproducible builds; Dependabot (docker) bumps them.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS prod-deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && find node_modules -name '*.map' -delete

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime
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
