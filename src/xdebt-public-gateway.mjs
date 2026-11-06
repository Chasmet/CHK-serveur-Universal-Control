/**
 * XDebt-only public gateway.
 *
 * Run this SEPARATELY from CHK Universal Control on the SAME Windows PC.
 * It is loopback-bound and forwards ONLY an explicit list of XDebt routes.
 * Never bind the MCP server itself to an unrestricted public tunnel.
 *
 * Requires Universal Control running locally with /xdebt/api/* available.
 * To make it Internet-accessible, terminate HTTPS through a separately
 * verified ingress that forwards ONLY to this gateway.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const PUBLIC_PREFIX = "/xdebt/api";
const UUID = "[a-f0-9-]{36}";
const patterns = Object.freeze([
  ["GET", /^\/xdebt\/api\/health$/],
  ["POST", /^\/xdebt\/api\/(register|login|logout)$/],
  ["GET", /^\/xdebt\/api\/profiles$/],
  ["GET", new RegExp("^/xdebt/api/profiles/" + UUID + "$")],
  ["GET", /^\/xdebt\/api\/me$/],
  ["PATCH", /^\/xdebt\/api\/me$/],
  ["PUT", /^\/xdebt\/api\/me$/],
  ["POST", /^\/xdebt\/api\/me\/(folders|invoices)$/],
  ["DELETE", new RegExp("^/xdebt/api/me/invoices/" + UUID + "$")]
]);
const MAX_REQUEST_BYTES = 180000;
const MAX_RESPONSE_BYTES = 2000000;
const RATE_WINDOW_MS = 60000;
const MAX_AUTH_ATTEMPTS = 25;
const MAX_TOTAL_REQUESTS = 300;
const allowed = (method, path) => patterns.some(([verb, re]) => verb === method && re.test(path));

function send(res, status, error, extra = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify({ error }));
}

function assertPort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("invalid_public_gateway_port");
  return port;
}

export function createXDebtPublicGateway(options = {}) {
  const gatewayHost = options.host ?? "127.0.0.1";
  const gatewayPort = assertPort(options.port, 8798);
  const upstreamPort = assertPort(options.upstreamPort, 8787);
  if (gatewayHost !== "127.0.0.1" && gatewayHost !== "::1") throw Error("gateway_must_listen_on_loopback");
  if (gatewayPort === upstreamPort) throw Error("gateway_upstream_port_conflict");
  const upstream = "http://127.0.0.1:" + upstreamPort;
  const limits = new Map();

  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("cross-origin-resource-policy", "same-site");
    res.setHeader("cache-control", "no-store");
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname;
      // Reject all other routes, including /mcp, /api/*, /chat and OAuth.
      if (!allowed(req.method, path) || url.search) return send(res, 404, "not_found");
      const remote = req.socket.remoteAddress || "unknown";
      const authRoute = path === PUBLIC_PREFIX + "/register" || path === PUBLIC_PREFIX + "/login";
      const key = remote + (authRoute ? ":auth" : ":other");
      const now = Date.now();
      const old = limits.get(key) || { time: now, count: 0 };
      const state = old.time + RATE_WINDOW_MS <= now ? { time: now, count: 0 } : old;
      state.count++;
      limits.set(key, state);
      // Do not trust client-supplied X-Forwarded-For: spoofing would bypass limits.
      if (state.count > (authRoute ? MAX_AUTH_ATTEMPTS : MAX_TOTAL_REQUESTS))
        return send(res, 429, "rate_limited", { "retry-after": "60" });
      if (limits.size > 5000) for (const [k, item] of limits)
        if (item.time + RATE_WINDOW_MS < now) limits.delete(k);

      if (["POST", "PUT", "PATCH"].includes(req.method) &&
          !(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return send(res, 415, "json_required");

      let chunks = [];
      let bytes = 0;
      for await (const piece of req) {
        bytes += piece.length;
        if (bytes > MAX_REQUEST_BYTES) return send(res, 413, "request_too_large");
        chunks.push(piece);
      }
      if (!["POST", "PUT", "PATCH"].includes(req.method) && bytes !== 0)
        return send(res, 400, "unexpected_body");

      const headers = { accept: "application/json" };
      const bearer = req.headers.authorization || "";
      if (typeof bearer === "string" && bearer.length < 2048 && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(bearer))
        headers.authorization = bearer;
      if (["POST", "PUT", "PATCH"].includes(req.method)) headers["content-type"] = "application/json";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(upstream + path, {
          method: req.method,
          headers,
          body: bytes > 0 ? Buffer.concat(chunks) : undefined,
          redirect: "error",
          signal: controller.signal
        });
        const declared = Number(response.headers.get("content-length") || 0);
        if (declared > MAX_RESPONSE_BYTES) return send(res, 502, "upstream_response_too_large");
        const reader = response.body?.getReader();
        const parts = [];
        let size = 0;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return send(res, 502, "upstream_response_too_large");
          }
          parts.push(value);
        }
        const body = Buffer.concat(parts);
        // Upstream XDebt always responds with JSON. Do not proxy arbitrary content.
        if (!(response.headers.get("content-type") || "").startsWith("application/json"))
          return send(res, 502, "invalid_upstream_response");
        res.writeHead(response.status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(body);
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      if (!res.headersSent) return send(res, 502, "upstream_unavailable");
      res.end();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 12000;
  return { server, host: gatewayHost, port: gatewayPort, upstream };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.XDEBT_PUBLIC_ENABLED !== "true") {
    console.error("XDebt public gateway disabled. Set XDEBT_PUBLIC_ENABLED=true after private tests.");
    process.exitCode = 1;
  } else {
    const gateway = createXDebtPublicGateway({
      port: process.env.XDEBT_PUBLIC_PORT || 8798,
      upstreamPort: process.env.PORT || 8787
    });
    gateway.server.listen(gateway.port, gateway.host, () => {
      console.log("XDebt allowlisted gateway listening on " + gateway.host + ":" + gateway.port);
      console.log("Proxied service: " + gateway.upstream + PUBLIC_PREFIX + "/*");
      console.log("MCP and owner dashboard: BLOCKED");
    });
  }
}
