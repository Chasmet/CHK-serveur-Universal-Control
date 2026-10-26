// Pirate Warrior 2 is the first local application of CHK Universal Control.
// Only connect to the existing Godot MCP on Windows loopback: never forward secrets to remote hosts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_FILE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CHKGodotDirectMCP", "settings.json");
const TOKEN_FORMAT = /^[a-f0-9]{64}$/;

export function createGodotBridge(options = {}) {
  const url = options.url || "http://127.0.0.1:8791";
  const settings = options.settings || process.env.CHK_GODOT_SETTINGS || DEFAULT_FILE;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):8791$/.test(url)) throw Error("godot_local_only");

  async function token() {
    const configured = options.token || process.env.CHK_GODOT_TOKEN;
    if (configured !== undefined && configured !== "") {
      if (!TOKEN_FORMAT.test(configured)) throw Error("godot_token_invalid");
      return configured;
    }
    try {
      const data = JSON.parse(await readFile(settings, "utf8"));
      if (!TOKEN_FORMAT.test(data.chat_token || "")) throw Error("godot_token_invalid");
      return data.chat_token;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function send(method, params = {}, waitMs = 15000) {
    const secret = await token();
    if (!secret) throw Error("godot_not_installed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      const response = await fetch(url + "/mcp/" + secret, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 42, method, params }),
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) throw Error("godot_http_" + response.status);
      const body = await response.json();
      if (body.error) throw Error("godot_rpc_" + (body.error.code ?? "error"));
      if (body.id !== 42) throw Error("godot_response_id_mismatch");
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
  async function tool(name, args = {}) {
    const result = await send("tools/call", { name, arguments: args }, name === "godot_status" ? 11000 : 55000);
    if (result?.isError) return { ok: false, error: "godot_execution_failed", result: result.content };
    const text = result?.content?.find(item => item.type === "text")?.text;
    if (!text) throw Error("godot_empty_tool_result");
    try { return { ok: true, ...JSON.parse(text) }; }
    catch { return { ok: true, text: text.slice(0, 10000) }; }
  }
  async function status() {
    try {
      const detail = await tool("godot_status", {});
      return { ...detail, connection: detail.ok === false ? "error" : "local", application: "Pirate Warrior 2" };
    } catch (error) {
      return { ok: false, editor_connected: false, application: "Pirate Warrior 2", error: String(error.message).slice(0, 120) };
    }
  }
  async function execute(name, args) {
    if (!["godot_run", "godot_batch"].includes(name)) throw Error("godot_action_forbidden");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("godot_invalid_args");
    return tool(name, args);
  }
  return { status, execute };
}
