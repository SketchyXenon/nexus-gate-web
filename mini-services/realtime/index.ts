import { createServer, type IncomingMessage, ServerResponse } from "http";
import { Server } from "socket.io";

// ====================================================================
// Nexus Gate — Realtime Mini-Service (single-port architecture)
// --------------------------------------------------------------------
// One HTTP server on PORT (default 3003):
//   • socket.io on path "/socket.io/" (the default)
//   • GET  /health  — health check (for Render/UptimeRobot)
//   • POST /emit    — server-to-server emit bridge (from Next.js API)
//
// The browser connects via the gateway:
//   io("/socket.io/?XTransformPort=3003")
// In production (no gateway), set NEXT_PUBLIC_REALTIME_URL to the
// deployed service URL (e.g. https://realtime.onrender.com).
//
// SECURITY (v10): CORS is now restricted to specific allowed origins
// instead of a wildcard "*". Allowed origins are read from the
// ALLOWED_ORIGINS environment variable (comma-separated). If not set,
// defaults to localhost and the production Vercel deployment.
// ====================================================================

const PORT = Number(process.env.PORT || process.env.IO_PORT || 3003);

// ---- Allowed CORS origins (STRICT — no wildcard) ----
// Set ALLOWED_ORIGINS in the environment, e.g.:
//   ALLOWED_ORIGINS="https://nexus-gate-web.vercel.app,http://localhost:3000"
// If not set, defaults to the production URL + localhost dev.
// IMPORTANT: The Vercel app is at nexus-gate-WEB.vercel.app (with -web).
const ALLOWED_ORIGINS: string[] = (
  process.env.ALLOWED_ORIGINS ||
  "https://nexus-gate-web.vercel.app,http://localhost:3000"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Check if a given origin is in the allowed list. */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

/** Build CORS headers for a given request origin. Returns an empty
 *  object if the origin is not allowed (no Access-Control-Allow-Origin). */
function getCorsHeaders(origin: string | undefined): Record<string, string> {
  if (origin && isAllowedOrigin(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
  }
  // Origin not allowed — return no CORS headers (browser will block)
  return {};
}

// ---------- shared HTTP handler (runs before socket.io) ----------
const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    const corsHeaders = getCorsHeaders(origin);

    // Set CORS headers (only if origin is allowed)
    for (const [key, value] of Object.entries(corsHeaders)) {
      res.setHeader(key, value);
    }

    if (req.method === "OPTIONS") {
      // Only respond to preflight if origin is allowed; otherwise 403
      if (origin && isAllowedOrigin(origin)) {
        res.writeHead(204);
      } else {
        res.writeHead(403);
      }
      res.end();
      return;
    }

    // ---- Health check (no CORS needed — server-to-server) ----
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "nexus-gate-realtime",
          clients: io.engine.clientsCount,
          uptime: process.uptime(),
        }),
      );
      return;
    }

    // ---- Emit bridge (server-to-server) ----
    // The /emit endpoint is called by the Next.js server (not the browser),
    // so CORS doesn't apply here. But we still validate the origin as
    // defense-in-depth (reject browser-based requests with disallowed origins).
    if (req.method === "POST" && req.url?.startsWith("/emit")) {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      try {
        const { channel, roomId, payload } = JSON.parse(body);
        if (channel === "attendance" && roomId) {
          io.to(roomId).emit("attendance", payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, room: roomId }));
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unknown channel" }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
      }
      return;
    }

    // ---- 404 for everything else (socket.io handles /socket.io/) ----
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  },
);

// ---------- socket.io server (browser-facing) ----------
// SECURITY: CORS restricted to allowed origins only (no wildcard "*").
// The browser will only be able to connect from pages served by the
// allowed origins (nexus-gate.vercel.app or localhost:3000).
const io = new Server(httpServer, {
  path: "/socket.io/",
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

io.on("connection", (socket) => {
  socket.on("subscribe", (roomId: string) => {
    if (typeof roomId === "string" && roomId.startsWith("event:")) {
      socket.join(roomId);
      socket.emit("subscribed", { roomId });
    }
  });
  socket.on("unsubscribe", (roomId: string) => {
    socket.leave(roomId);
  });
});

// ---------- start ----------
httpServer.listen(PORT, () => {
  console.log(`[nexus-gate-realtime] listening on port ${PORT}`);
  console.log(`  Allowed CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`  socket.io:  ws://*:${PORT}/socket.io/`);
  console.log(`  emit bridge: POST http://*:${PORT}/emit`);
  console.log(`  health:     GET  http://*:${PORT}/health`);
});

// ---------- graceful shutdown ----------
process.on("SIGTERM", () => {
  console.log("[nexus-gate-realtime] SIGTERM received, shutting down...");
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
});
process.on("SIGINT", () => process.exit(0));
