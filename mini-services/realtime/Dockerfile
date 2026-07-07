FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY index.ts ./

FROM oven/bun:1 AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/index.ts ./index.ts
COPY --from=build /app/package.json ./package.json

# Render sets PORT automatically. Default to 3003 for local Docker runs.
ENV PORT=3003
EXPOSE 3003

# Render uses healthCheckPath: /health from render.yaml for health checks.
# We don't set a Docker HEALTHCHECK here because:
#   1. Render's native health check is more reliable
#   2. The oven/bun:1 image doesn't include curl/wget
#   3. bun -e with fetch can hang on some networks

# Start the service. Use "bun index.ts" (not "bun run index.ts") —
# "bun run" looks for a script name in package.json, while "bun" runs
# the file directly. Both work, but "bun index.ts" is more explicit.
CMD ["bun", "index.ts"]
