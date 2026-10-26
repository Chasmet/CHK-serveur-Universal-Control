import { SERVER_VERSION } from "./version.mjs";
import { createServer as httpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Store, clean, safeEqual } from "./core.mjs";
import { createSecurity } from "./security.mjs";
import { createAI } from "./ai.mjs";
import { createMCP } from "./mcp.mjs";
import { createGodotBridge } from "./godot.mjs";
import { createCryptoModule } from "./crypto.mjs";
import { createMarketResearch } from "./crypto-markets.mjs";
import { createCryptoMarket } from "./crypto-market.mjs";
import { createCryptoMonitor } from "./crypto-monitor.mjs";

const baseConfig = () => ({
  port: Number(process.env.PORT || 8787), host: process.env.HOST || "127.0.0.1",
  base: (process.env.PUBLIC_BASE_URL || "http://localhost:8787").replace(/\/$/, ""),
  adminPassword: process.env.ADMIN_PASSWORD || "",
  jwtSecret: process.env.JWT_SECRET || "",
  file: process.env.DATA_FILE || "./data/server.json",
  legacyUrl: process.env.CHK_LEGACY_MCP_URL || "",
  ollamaUrl: process.env.OLLAMA_URL || "",
  ollamaModel: process.env.OLLAMA_MODEL || "qwen3:1.7b",
  allowLocalOAuth: process.env.ALLOW_LOCAL_OAUTH === "true"
});
async function readBody(req, limit = 32768) {
  const pieces = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Error("body_too_large");
    pieces.push(part);
  }
  const str = Buffer.concat(pieces).toString("utf8");
  if (!str) return {};
  if ((req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(str));
  return JSON.parse(str);
}
export async function buildServer(opts = {}) {
  const config = { ...baseConfig(), ...opts };
  if (config.adminPassword.length < 16 || config.jwtSecret.length < 32 || !/^https?:\/\/[^/]+$/.test(config.base)) throw Error("Configurez ADMIN_PASSWORD (16+), JWT_SECRET (32+) et PUBLIC_BASE_URL");
  if (!config.base.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.base)) throw Error("HTTPS requis en production");
  const store = await new Store(config.file).init();
  const security = createSecurity(config, store);
  const ai = createAI(config, store);
  const godot = createGodotBridge();
  const crypto = createCryptoModule(store);
  const markets = createMarketResearch();
  const advancedMarket = createCryptoMarket();
  const monitor = createCryptoMonitor(store, crypto);
  const loginFailures = new Map();
  async function legacyCall(tool, args) {
    if (!config.legacyUrl) throw Error("legacy_not_configured");
    if (!["server_info", "android_status", "android_command"].includes(tool)) throw Error("legacy_tool_forbidden");
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 50000);
    try {
      const reply = await fetch(config.legacyUrl, {
        method: "POST", redirect: "error", signal: ctrl.signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })
      });
      if (!reply.ok) throw Error("legacy_http_" + reply.status);
      const packet = await reply.json();
      if (packet.error || packet.result?.isError) throw Error("legacy_tool_error");
      const value = packet.result?.content?.find(c => c.type === "text")?.text;
      try { return JSON.parse(value); } catch { return { text: String(value || "").slice(0, 4000) }; }
    } finally { clearTimeout(timeout); }
  }
  async function approveTask(id) {
    const job = await store.approve(id);
    if (job.app_id === "godot-local") {
      // A write never repeats silently after a lost or timed-out response.
      await store.markLegacy(id, null, "leased");
      try {
        const result = await godot.execute(job.action, job.args);
        return await store.markLegacy(id, result, result.ok === false ? "failed" : "completed");
      } catch (error) {
        return await store.markLegacy(id, { error: String(error.message).slice(0, 160), execution_state: "unknown", retry_command: false }, "unknown");
      }
    }
    if (job.app_id !== "chk-legacy") return job;
    // Mark as executing before outbound call: timeout/crash must NOT auto-repeat a write.
    await store.markLegacy(id, null, "leased");
    try {
      const reply = await legacyCall("android_command", job.args);
      return await store.markLegacy(id, reply, "completed");
    } catch (e) {
      return await store.markLegacy(id, { error: e.message, execution_state: "unknown", retry_command: false }, "unknown");
    }
  }
  const mcp = createMCP(config, store, security, ai, legacyCall, approveTask, godot, crypto, markets, advancedMarket, monitor);
  const json = security.json;
  const server = httpServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    const url = new URL(req.url, config.base);
    try {
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok", service: "CHK Universal Control", version: SERVER_VERSION, browser_protocol: 2 });
      if (req.method === "GET" && url.pathname === "/") { res.writeHead(302, { location: "/chat" }); return res.end(); }
      if (req.method === "GET" && url.pathname === "/chat") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(await readFile(fileURLToPath(new URL("../public/chat.html", import.meta.url)), "utf8"));
      }
      if (req.method === "GET" && url.pathname === "/oauth-login.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(await readFile(fileURLToPath(new URL("../public/oauth-login.js", import.meta.url)), "utf8"));
      }
      if (req.method === "GET" && url.pathname === "/chat.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(await readFile(fileURLToPath(new URL("../public/chat.js", import.meta.url)), "utf8"));
      }
      const body = ["POST", "PUT"].includes(req.method) ? await readBody(req, /^\/api\/agent\/[a-f0-9-]{36}\/result$/.test(url.pathname) ? 350000
        : ["/mcp", "/api/tasks"].includes(url.pathname) ? 100000 : 32768) : {};
      const oauth = await security.route(req, res, url, body);
      if (oauth !== false) return;
      if (req.method === "POST" && url.pathname === "/api/login") {
        const ip = req.socket.remoteAddress || "unknown";
        const fail = loginFailures.get(ip) || { count: 0, until: 0 };
        if (fail.until > Date.now()) return json(res, 429, { error: "too_many_attempts" });
        if (!safeEqual(body.password || "", config.adminPassword)) {
          fail.count++;
          if (fail.count >= 5) fail.until = Date.now() + 600000;
          loginFailures.set(ip, fail);
          return json(res, 401, { error: "invalid_credentials" });
        }
        loginFailures.delete(ip);
        return json(res, 200, { access_token: security.token() });
      }
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return json(res, 405, { error: "POST_required" }, { allow: "POST" });
        return mcp(body, req, res);
      }
      if (req.method === "POST" && url.pathname === "/api/onboard") return json(res, 201, await store.joinApp(body));
      if (url.pathname.startsWith("/api/agent/")) {
        const bits = url.pathname.split("/");
        const id = bits[3];
        const credential = security.bearer(req);
        if (!store.appAuthorized(id, credential)) return json(res, 401, { error: "app_auth_required" });
        if (bits[4] === "capabilities" && req.method === "PUT")
          return json(res, 200, store.state.apps[id]?.name === "CHK Agent Browser Android · Local 3"
            ? await store.extendBrowserCapabilities(id, body)
            : await store.extendVisualCapabilities(id, body));
        if (bits[4] === "poll" && req.method === "GET") return json(res, 200, { task: await store.poll(id) });
        if (bits[4] === "result" && req.method === "POST") return json(res, 200, { task: await store.result(id, body.task_id, body.result) });
        return json(res, 404, { error: "unknown_agent_endpoint" });
      }
      const needed = req.method === "GET" ? "mcp:read" : "mcp:write";
      if (url.pathname.startsWith("/api/") && !security.verify(security.bearer(req), needed)) return security.unauthorized(res, needed);
      if (req.method === "GET" && url.pathname === "/api/apps") return json(res, 200, { apps: store.listApps(Boolean(config.legacyUrl)) });
      if (req.method === "POST" && url.pathname === "/api/apps") return json(res, 201, await store.registerApp(body));
      if (req.method === "POST" && url.pathname === "/api/invites") return json(res, 201, await store.createInvite());
      if (req.method === "GET" && url.pathname === "/api/tasks") return json(res, 200, { tasks: store.listJobs() });
      if (req.method === "POST" && url.pathname === "/api/tasks") return json(res, 201, { task: await store.submit({ ...body, source: "api", legacy: Boolean(config.legacyUrl) }) });
      if (req.method === "POST" && url.pathname === "/api/chat") return json(res, 200, await ai.chat(body.message));
      const taskMatch = /^\/api\/tasks\/([a-f0-9]{36})(?:\/(approve|cancel))?$/.exec(url.pathname);
      if (taskMatch) {
        const id = taskMatch[1];
        if (req.method === "GET" && !taskMatch[2]) return json(res, 200, { task: store.getJob(id) });
        if (req.method === "POST" && taskMatch[2] === "approve") return json(res, 200, { task: await approveTask(id) });
        if (req.method === "POST" && taskMatch[2] === "cancel") return json(res, 200, { task: await store.cancel(id) });
      }
      return json(res, 404, { error: "not_found" });
    } catch (err) {
      const ordinary = /^(invalid_|app_|capability_|job_|unknown_|not_|cannot_|empty_|body_|client_|result_|legacy_|ollama_|idempotency_)/.test(err.message);
      return json(res, ordinary ? 400 : 500, { error: ordinary ? err.message : "internal_error" });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return { server, store, config };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, config } = await buildServer();
  server.listen(config.port, config.host, () => console.log("CHK Universal Control listening on " + config.host + ":" + config.port));
}
