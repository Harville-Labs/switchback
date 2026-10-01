# Switchback sites (docs/sites.md). Build from the repository root:
#   docker build -f apps/site/Dockerfile -t switchback-site .
FROM oven/bun:1.4 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps/site ./apps/site
COPY scripts/install.sh scripts/install.ps1 ./scripts/
# The lockfile lists every workspace; their manifests are enough to install.
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/vscode/package.json ./apps/vscode/package.json
RUN bun install --frozen-lockfile --ignore-scripts
WORKDIR /repo/apps/site
RUN bun --bun run build

# The build bundles every dependency, so the runtime image is Node and the output.
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/site/build ./build
COPY --from=build --chown=node:node /repo/apps/site/drizzle ./drizzle
USER node
EXPOSE 3000
CMD ["node", "build"]
