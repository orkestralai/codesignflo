# The CoDesignFlo server image for a self-hosted box: the web app, the MCP and the database migrations (with psql
# to apply them: the compose file's `migrate` service runs this image with migrate.sh).
# Build from the repository's root: docker build -f selfhost/Dockerfile -t codesignflo-server .

FROM node:22.23.4-bookworm-slim AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /src
# The manifests first: the install is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/plugin/package.json packages/plugin/
COPY service/package.json service/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter codesignflo --filter "@codesignflo/service..." --filter "@codesignflo/plugin..."
COPY packages/core packages/core
COPY packages/cli/src packages/cli/src
COPY packages/plugin packages/plugin
COPY service service
# The server, and the Figma plugin template it fills in with the box's address for /plugin.zip.
RUN pnpm --filter @codesignflo/core build && node service/server/build.mjs /out \
 && cd packages/plugin && node scripts/build.mjs --flavor selfhost-template --out /out/plugin-template

# The migrations, with the personal address in an early one (the first cloud admin) blanked: done here, so no layer
# of the published image has it.
RUN cp -r service/supabase/migrations /migrations \
 && sed -i -E 's/[A-Za-z0-9._%+-]+@(gmail|googlemail)\.com/admin@example.com/g' /migrations/*.sql

FROM node:22.23.4-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/ ./
COPY --from=build /migrations ./migrations
COPY --chmod=755 selfhost/scripts/migrate.sh ./migrate.sh
ENV NODE_ENV=production PORT=3000 CODESIGNFLO_MODE=selfhost CODESIGNFLO_PLUGIN_TEMPLATE=/app/plugin-template
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "index.mjs"]
