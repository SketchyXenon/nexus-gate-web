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

# CRITICAL: Do NOT set ENV PORT here.
# Render sets the PORT environment variable automatically (usually to
# port 10000) and routes traffic to that port. If we set ENV PORT=3003
# here, it OVERRIDES Render's PORT, causing the service to listen on
# 3003 while Render routes traffic to a different port → 502 Bad Gateway.
# The code already defaults to 3003 when PORT is not set (local dev).

# EXPOSE is documentation only — it doesn't affect Render's routing.
# We expose 10000 (Render's default) for clarity, but the actual port
# is determined by process.env.PORT at runtime.
EXPOSE 10000

# Render uses healthCheckPath: /health from render.yaml for health checks.

# Start the service. Use "bun index.ts" (not "bun run index.ts") —
# "bun run" looks for a script name in package.json, while "bun" runs
# the file directly. Both work, but "bun index.ts" is more explicit.
CMD ["bun", "index.ts"]