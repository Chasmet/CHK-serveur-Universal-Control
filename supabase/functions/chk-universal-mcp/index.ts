// CHK Universal MCP Router — Supabase Edge, isolated from chk-home-mcp-gateway.
// Each installed application is enabled independently in chk_uc_apps.
// No tokens/endpoints are returned to MCP clients. Read-only by default.
import { createClient } from "npm:@supabase/supabase-js@2.55.0";

const PROJECT_URL = Deno.env.get("SUPABASE_URL") || "";
const KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  try { if (keys) return JSON.parse(keys).default || ""; } catch { /* legacy fallback */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
})();
const supabase = createClient(PROJECT_URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const SERVICE = "CHK Universal Control - Supabase";
const VERSION = "0.2.0-edge";
const MAX_BODY = 32 * 1024;
const MAX_UPSTREAM_BODY = 96 * 1024;
const APP_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,100}$/;
const PATH_CAP = /\/mcp\/([a-f0-9]{64})\/?$/;
const SAFE_HOST = /(^|\.)(supabase\.co|onrender\.com|ts\.net)$/i;

const resultText = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError
});
function http(status: number, data: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "null",
      ...extra
    }
  });
}
function reply(id: unknown, result: unknown) { return http(200, { jsonrpc: "2.0", id, result }); }
function rpcError(id: unknown, code: number, message: string) {
  return http(200, { jsonrpc: "2.0", id, error: { code, message } });
}
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], readOnly = true) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly },
    securitySchemes: [{ type: "noauth" }]
  };
}
const TOOLS = [
  tool("server_info", "État du répartiteur MCP CHK Supabase. La disponibilité Android doit être vérifiée séparément.", {}),
  tool("apps_list", "Liste les applications configurées, chacune activable séparément.", {}),
  tool("app_tools", "Liste les outils autorisés d'une application, avec état de ses permissions.", {
    app_id: { type: "string", description: "Identifiant retourné par apps_list" }
  }, ["app_id"]),
  tool("app_call", "Exécute un outil explicitement autorisé sur une application activée. Les écritures sont bloquées par défaut. Ne jamais déclarer un succès avant le résultat.", {
    app_id: { type: "string" },
    tool: { type: "string", description: "Nom exact d'outil présent dans app_tools" },
    arguments: { type: "object" },
    request_id: { type: "string", description: "Identifiant stable obligatoire pour une écriture afin d'empêcher une exécution en double" }
  }, ["app_id", "tool"], false)
];
function safeEndpoint(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      url.port === "" && SAFE_HOST.test(url.hostname) && url.pathname.length > 1;
  } catch { return false; }
}
async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const raw = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(raw)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function authorized(cap: string) {
  const hashed = await digest(cap);
  const { data, error } = await supabase.from("chk_uc_access")
    .select("id").eq("secret_hash", hashed).eq("active", true).limit(1).maybeSingle();
  if (error) throw new Error("auth_storage_unavailable");
  return !!data;
}
async function listApps() {
  const { data, error } = await supabase.from("chk_uc_apps")
    .select("id,name,enabled,allow_writes,read_tools,write_tools").order("name");
  if (error) throw new Error("app_registry_unavailable");
  return (data || []).map(a => ({
    id: a.id, name: a.name, enabled: a.enabled, writes_enabled: a.allow_writes,
    readable_tools: a.read_tools.length,
    writable_tools: a.write_tools.length,
    online: "not_checked"
  }));
}
async function getApp(id: unknown) {
  if (typeof id !== "string" || !APP_ID.test(id)) throw new Error("invalid_app_id");
  const { data, error } = await supabase.from("chk_uc_apps")
    .select("id,name,enabled,endpoint,read_tools,write_tools,allow_writes")
    .eq("id", id).maybeSingle();
  if (error) throw new Error("app_registry_unavailable");
  if (!data) throw new Error("unknown_application");
  return data;
}
async function audit(app_id: string, operation: string, outcome: string, request_id: string | null) {
  const { error } = await supabase.from("chk_uc_audit")
    .insert({ app_id, operation, outcome, request_id });
  if (error) throw new Error("audit_write_unavailable");
}
async function executeApp(args: Record<string, unknown>) {
  const app = await getApp(args.app_id);
  const toolName = args.tool;
  if (!app.enabled) throw new Error("application_disabled");
  if (typeof toolName !== "string" || !TOOL_NAME.test(toolName)) throw new Error("invalid_tool");
  const read = app.read_tools.includes(toolName);
  const write = app.write_tools.includes(toolName);
  if (!read && !write) throw new Error("tool_not_allowed_for_application");
  if (!read && write && !app.allow_writes) throw new Error("write_access_disabled");
  if (!safeEndpoint(app.endpoint)) throw new Error("unapproved_endpoint");
  const input = args.arguments ?? {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("invalid_arguments");
  if (JSON.stringify(input).length > 16000) throw new Error("arguments_too_large");
  const rid = typeof args.request_id === "string" ? args.request_id : "";
  if (!read) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(rid)) throw new Error("write_requires_stable_request_id");
    // The audit row is persisted BEFORE the operation. Duplicate IDs are never replayed.
    const { error } = await supabase.from("chk_uc_audit")
      .insert({ app_id: app.id, operation: toolName.slice(0, 80), outcome: "started", request_id: app.id + ":" + rid });
    if (error?.code === "23505") throw new Error("duplicate_write_id_check_original_result");
    if (error) throw new Error("audit_write_unavailable");
  }
  const rpc = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: toolName, arguments: input } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 48000);
  try {
    const response = await fetch(app.endpoint, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(rpc)
    });
    if (!response.ok) throw new Error("upstream_http_" + response.status);
    const text = await response.text();
    if (text.length > MAX_UPSTREAM_BODY) throw new Error("upstream_response_too_large");
    const packet = JSON.parse(text);
    if (packet.jsonrpc !== "2.0" || packet.id !== rpc.id) throw new Error("upstream_jsonrpc_mismatch");
    if (packet.error) return { error: "upstream_mcp_error", details: packet.error };
    if (!packet.result) throw new Error("upstream_missing_result");
    // Never leak app secrets or complete registered endpoint. Only return tool response.
    return packet.result;
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e), execution_state: "unknown", retry_command: false };
  } finally {
    clearTimeout(timeout);
  }
}
function isOversize(req: Request) {
  const length = req.headers.get("content-length");
  return length !== null && Number(length) > MAX_BODY;
}
Deno.serve(async (req: Request) => {
  const pathname = new URL(req.url).pathname;
  // The health route is public, but reveals no credentials or applications.
  if (req.method === "GET" && pathname.endsWith("/healthcheck")) {
    return http(200, { service: SERVICE, version: VERSION, hosting: "supabase-edge", online: true, model_running_here: false });
  }
  const match = PATH_CAP.exec(pathname);
  if (!match) return http(404, { error: "not_found" });
  if (req.method !== "POST") return http(405, { error: "post_required" }, { allow: "POST" });
  if (req.headers.get("origin")) return http(403, { error: "browser_origin_forbidden" });
  if (isOversize(req)) return http(413, { error: "request_too_large" });
  let rpc: any;
  try {
    const body = await req.text();
    if (body.length > MAX_BODY) return http(413, { error: "request_too_large" });
    rpc = JSON.parse(body);
  } catch {
    return http(400, { error: "invalid_json" });
  }
  const id = rpc && typeof rpc === "object" ? rpc.id : null;
  try {
    if (!await authorized(match[1])) return http(401, { error: "unauthorized" });
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || Array.isArray(rpc)) {
      return rpcError(id, -32600, "Invalid Request");
    }
    if (id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return reply(id, {
      protocolVersion: rpc.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVICE, version: VERSION }
    });
    if (rpc.method === "ping") return reply(id, {});
    if (rpc.method === "tools/list") return reply(id, { tools: TOOLS });
    if (rpc.method !== "tools/call") return rpcError(id, -32601, "Method not found");
    const name = rpc.params?.name;
    const args = rpc.params?.arguments || {};
    let output: unknown;
    if (name === "server_info") output = { service: SERVICE, version: VERSION, hosting: "supabase-edge", apps: (await listApps()).length, model_running_here: false };
    else if (name === "apps_list") output = await listApps();
    else if (name === "app_tools") {
      const app = await getApp(args.app_id);
      output = { id: app.id, name: app.name, enabled: app.enabled, read_tools: app.read_tools,
        write_tools: app.allow_writes ? app.write_tools : [], writes_enabled: app.allow_writes };
    } else if (name === "app_call") {
      output = await executeApp(args);
      if (output && typeof output === "object" && "content" in output) return reply(id, output);
    } else return rpcError(id, -32601, "Unknown tool");
    return reply(id, resultText(output, !!(output && typeof output === "object" && "error" in output)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_failure";
    const exposed = /^(unknown_|invalid_|tool_|application_|write_|duplicate_|arguments_|upstream_|audit_)/.test(message);
    return reply(id, resultText({ error: exposed ? message : "internal_error" }, true));
  }
});
