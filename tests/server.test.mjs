import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { buildServer } from "../src/server.mjs";
import { Store } from "../src/core.mjs";

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "chk-universal-test-"));
  const file = join(dir, "db.json");
  const options = { host: "127.0.0.1", port: 0, base: "http://localhost:8787",
    adminPassword: "strong-test-password-123456", jwtSecret: "a".repeat(64),
    file, ollamaUrl: "", legacyUrl: "" };
  const { server } = await buildServer(options);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const request = async (path, { method = "GET", bearer = "", body, form = false, redirect = "follow" } = {}) => {
    const headers = {};
    if (bearer) headers.authorization = "Bearer " + bearer;
    if (body) headers["content-type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    return fetch(url + path, { method, headers, body: body ? (form ? new URLSearchParams(body) : JSON.stringify(body)) : undefined, redirect });
  };
  const login = await request("/api/login", { method: "POST", body: { password: options.adminPassword } });
  assert.equal(login.status, 200);
  const { access_token } = await login.json();
  return { request, access_token, options, file };
}
test("health, protected MCP, JSON-RPC discovery", async t => {
  const { request, access_token } = await setup(t);
  assert.equal((await request("/health")).status, 200);
  const anon = await request("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate"), /oauth-protected-resource/);
  const rpc = async (method, params = {}) => (await (await request("/mcp", { method: "POST", bearer: access_token, body: { jsonrpc: "2.0", id: 1, method, params } })).json()).result;
  assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).serverInfo.name, "CHK Universal Control");
  const list = await rpc("tools/list");
  assert.ok(list.tools.some(tool => tool.name === "app_invite"));
  assert.ok(!list.tools.some(tool => tool.name === "task_approve"));
  assert.ok(list.tools.every(tool => tool.securitySchemes?.length));
  assert.equal((await request("/mcp")).status, 405);
});
test("auto-onboarding invitation, queue, approval, delivery", async t => {
  const { request, access_token } = await setup(t);
  const authed = (path, method, body) => request(path, { method, bearer: access_token, body });
  const inviteRes = await authed("/api/invites", "POST", {});
  assert.equal(inviteRes.status, 201);
  const invite = await inviteRes.json();
  const newApp = { name: "Test Android", invite: invite.invite,
    capabilities: [{ name: "list_files", readOnly: true }, { name: "delete_file", readOnly: false }] };
  const joined = await request("/api/onboard", { method: "POST", body: newApp });
  assert.equal(joined.status, 201);
  const app = await joined.json();
  assert.ok(app.secret.startsWith("chkapp_"));
  assert.equal((await request("/api/onboard", { method: "POST", body: newApp })).status, 400);
  assert.equal((await request("/api/agent/" + app.id + "/poll", { bearer: "bad" })).status, 401);
  const read = await (await authed("/api/tasks", "POST", { app_id: app.id, action: "list_files", args: { directory: "videos" }, request_id: "read-id" })).json();
  assert.equal(read.task.state, "queued");
  const repeated = await (await authed("/api/tasks", "POST", { app_id: app.id, action: "list_files", args: { directory: "videos" }, request_id: "read-id" })).json();
  assert.equal(repeated.task.id, read.task.id);
  const leased = await (await request("/api/agent/" + app.id + "/poll", { bearer: app.secret })).json();
  assert.equal(leased.task.id, read.task.id);
  assert.equal((await (await request("/api/agent/" + app.id + "/poll", { bearer: app.secret })).json()).task, null);
  const done = await request("/api/agent/" + app.id + "/result", { method: "POST", bearer: app.secret, body: { task_id: read.task.id, result: { ok: true, files: ["a.mp4"] } } });
  assert.equal((await done.json()).task.state, "completed");
  const destructive = await (await authed("/api/tasks", "POST", { app_id: app.id, action: "delete_file", args: { name: "a.mp4" } })).json();
  assert.equal(destructive.task.state, "pending_approval");
  assert.equal((await (await request("/api/agent/" + app.id + "/poll", { bearer: app.secret })).json()).task, null);
  assert.equal((await (await authed("/api/tasks/" + destructive.task.id + "/approve", "POST", {})).json()).task.state, "queued");
  assert.equal((await (await request("/api/agent/" + app.id + "/poll", { bearer: app.secret })).json()).task.id, destructive.task.id);
});
test("OAuth2.1 PKCE + issuer + audience for ChatGPT", async t => {
  const { request, options } = await setup(t);
  const metadata = await (await request("/.well-known/oauth-protected-resource")).json();
  assert.equal(metadata.resource, options.base + "/mcp");
  const redirect_uri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const clientResp = await request("/oauth/register", { method: "POST", body: { client_name: "ChatGPT", redirect_uris: [redirect_uri], token_endpoint_auth_method: "none" } });
  assert.equal(clientResp.status, 201);
  const client = await clientResp.json();
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri, code_challenge_method: "S256", code_challenge: challenge, resource: options.base + "/mcp", scope: "mcp:read mcp:write", state: "hello" });
  assert.equal((await request("/oauth/authorize?" + query)).status, 200);
  const approved = await request("/oauth/authorize?" + query, { method: "POST", form: true, body: { password: options.adminPassword }, redirect: "manual" });
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get("location"));
  assert.equal(callback.searchParams.get("iss"), options.base);
  assert.equal(callback.searchParams.get("state"), "hello");
  const payload = { grant_type: "authorization_code", client_id: client.client_id, code: callback.searchParams.get("code"), redirect_uri, resource: options.base + "/mcp", code_verifier: verifier };
  assert.equal((await request("/oauth/token", { method: "POST", form: true, body: { ...payload, code_verifier: "x".repeat(43) } })).status, 400);
  const exchanged = await request("/oauth/token", { method: "POST", form: true, body: payload });
  assert.equal(exchanged.status, 200);
  const access = await exchanged.json();
  assert.equal((await request("/mcp", { method: "POST", bearer: access.access_token, body: { jsonrpc: "2.0", id: 5, method: "tools/list" } })).status, 200);
  assert.equal((await request("/oauth/token", { method: "POST", form: true, body: { grant_type: "refresh_token", client_id: client.client_id, resource: options.base + "/mcp", refresh_token: access.refresh_token } })).status, 200);
  assert.equal((await request("/oauth/register", { method: "POST", body: { redirect_uris: ["https://evil.test/steal"] } })).status, 400);
});
test("crash leaves leased tasks UNKNOWN without re-execution", async t => {
  const { request, access_token, file } = await setup(t);
  const invite = await (await request("/api/invites", { method: "POST", bearer: access_token, body: {} })).json();
  const app = await (await request("/api/onboard", { method: "POST", body: { name: "Worker", invite: invite.invite, capabilities: [{ name: "read", readOnly: true }] } })).json();
  const job = await (await request("/api/tasks", { method: "POST", bearer: access_token, body: { app_id: app.id, action: "read", args: {} } })).json();
  await request("/api/agent/" + app.id + "/poll", { bearer: app.secret });
  const reloaded = await new Store(file).init();
  assert.equal(reloaded.getJob(job.task.id).state, "unknown");
});
