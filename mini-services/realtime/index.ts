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

// ---- Crash prevention: log but never exit on uncaught errors ----
// Without this, any uncaught exception kills the service and Render
// returns 502 until the service restarts (which can take 30+ seconds).
process.on("uncaughtException", (err) => {
  console.error("[nexus-gate-realtime] uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[nexus-gate-realtime] unhandledRejection:", err);
});

const PORT = Number(process.env.PORT || process.env.IO_PORT || 3003);

// ---- Allowed CORS origins (STRICT — no wildcard) ----
// Set ALLOWED_ORIGINS in the environment, e.g.:
//   ALLOWED_ORIGINS="https://nexus-gate-web.vercel.app,http://localhost:3000"
// If not set, defaults to the production URL + localhost dev.
// IMPORTANT: The Vercel app is at nexus-gate-WEB.vercel.app (with -web).
const ALLOWED_ORIGINS: string[] = (
  process.env.ALLOWED_ORIGINS || "https://nexus-gate-web.vercel.app"
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
// IMPORTANT: socket.io polling requests (/socket.io/?...) are handled
// by socket.io's internal middleware, NOT by this handler. But this
// handler runs FIRST and can set CORS headers that socket.io won't
// override. So we set CORS headers here for ALL requests, including
// /socket.io/ polling. This fixes the "No 'Access-Control-Allow-Origin'
// header is present" error on polling requests.
const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    const corsHeaders = getCorsHeaders(origin);

    // Set CORS headers on ALL responses (including socket.io polling).
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
    // Use startsWith instead of === to handle query params or trailing
    // slashes that Render's health checker might add.
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ---- Root endpoint (also serves as a simple health check) ----
    if (req.method === "GET" && (req.url === "/" || req.url === "")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "nexus-gate-realtime" }));
      return;
    }

    // ---- Emit bridge (server-to-server, authenticated) ----
    // The /emit endpoint is called by the Next.js server (not the browser).
    // Requires a shared secret in the x-emit-secret header to prevent
    // unauthorized parties from broadcasting fake attendance notifications.
    if (req.method === "POST" && req.url?.startsWith("/emit")) {
      // Verify the shared secret.
      const emitSecret = process.env.EMIT_SECRET || "";
      const providedSecret = req.headers["x-emit-secret"] || "";
      if (!emitSecret || providedSecret !== emitSecret) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
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
    // NOTE: socket.io requests (/socket.io/?EIO=4&transport=polling) are
    // intercepted by socket.io's middleware BEFORE reaching this 404.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  },
);

// ---------- socket.io server (browser-facing) ----------
// SECURITY: CORS restricted to allowed origins only (no wildcard "*").
// The browser will only be able to connect from pages served by the
// allowed origins (nexus-gate-web.vercel.app or localhost:3000).
const io = new Server(httpServer, {
  path: "/socket.io/",
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: false,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  // Allow large Engine.IO payloads (default 1MB can be too small for
  // some polling responses with many connected clients).
  maxHttpBufferSize: 1e6,
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
// Bind to 0.0.0.0 (all network interfaces) — Render requires this.
// If we only pass PORT (no host), Node defaults to 0.0.0.0 on Linux,
// but being explicit avoids issues on some container runtimes.
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[nexus-gate-realtime] listening on 0.0.0.0:${PORT}`);
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
