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


test("MCP apps_list returns structured object and exposes online Android connection", async t => {
  const { request, access_token } = await setup(t);
  const callMcp = async (name, args = {}) => {
    const http = await request("/mcp", {
      method: "POST", bearer: access_token,
      body: { jsonrpc: "2.0", id: 77, method: "tools/call", params: { name, arguments: args } }
    });
    assert.equal(http.status, 200);
    const payload = await http.json();
    assert.ok(payload.result, JSON.stringify(payload.error));
    return payload.result;
  };
  const before = await callMcp("apps_list");
  assert.equal(typeof before.structuredContent, "object");
  assert.ok(!Array.isArray(before.structuredContent),
    "ChatGPT MCP requires structuredContent to be a JSON object, never an array");
  assert.deepEqual(before.structuredContent.apps, []);
  const invite = await callMcp("app_invite");
  const onboarding = await request("/api/onboard", {
    method: "POST", body: {
      name: "CHK Agent Browser Android · Local 3",
      invite: invite.structuredContent.invite,
      capabilities: [
        { name: "browser_status", readOnly: true },
        { name: "files_list", readOnly: true },
        { name: "files_move", readOnly: false }
      ]
    }
  });
  assert.equal(onboarding.status, 201);
  const app = await onboarding.json();
  const listed = await callMcp("apps_list");
  assert.ok(!Array.isArray(listed.structuredContent));
  assert.equal(listed.structuredContent.apps.length, 1);
  const entry = listed.structuredContent.apps[0];
  assert.equal(entry.id, app.id);
  assert.equal(entry.name, "CHK Agent Browser Android · Local 3");
  assert.equal(entry.online, false);
  assert.equal(entry.capabilities.length, 3);

  const submitted = await callMcp("task_submit", {
    app_id: app.id, action: "browser_status",
    args: {}, request_id: "local3-smoke-status"
  });
  assert.equal(submitted.structuredContent.state, "queued");
  const leased = await (await request("/api/agent/" + app.id + "/poll",
    { bearer: app.secret })).json();
  assert.equal(leased.task.id, submitted.structuredContent.id);
  const response = await request("/api/agent/" + app.id + "/result", {
    method: "POST", bearer: app.secret,
    body: { task_id: leased.task.id, result: { ok: true, connected: true } }
  });
  assert.equal(response.status, 200);
  const readBack = await callMcp("task_get", { task_id: leased.task.id });
  assert.equal(readBack.structuredContent.state, "completed");
  assert.deepEqual(readBack.structuredContent.result, { ok: true, connected: true });
  const after = await callMcp("apps_list");
  assert.equal(after.structuredContent.apps[0].online, true);

  const mutation = await callMcp("task_submit", {
    app_id: app.id, action: "files_move",
    args: { path: "scratch/check.txt", destination: "scratch/check2.txt" },
    request_id: "local3-smoke-move"
  });
  assert.equal(mutation.structuredContent.state, "pending_approval");
  const noCommand = await (await request("/api/agent/" + app.id + "/poll",
    { bearer: app.secret })).json();
  assert.equal(noCommand.task, null, "Unapproved filesystem mutations must not reach Android");
});

test("Local 3 upgrades paired tools, returns actual screenshots, and acknowledges results idempotently", async t => {
  const { request, access_token } = await setup(t);
  const { readFile } = await import('node:fs/promises');
  const capabilities = JSON.parse(await readFile(new URL('../src/browser-capabilities.json', import.meta.url), 'utf8'));
  const app = await (await request('/api/apps', {method:'POST', bearer:access_token,
    body:{name:'CHK Agent Browser Android · Local 3',capabilities:[{name:'browser_status',readOnly:true}]}})).json();
  const route = '/api/agent/' + app.id;
  assert.equal((await request(route+'/capabilities', {method:'PUT',bearer:'wrong',body:{capabilities}})).status,401);
  const bad = capabilities.map(c => c.name === 'desktop' ? {...c,readOnly:true} : c);
  assert.equal((await request(route+'/capabilities', {method:'PUT',bearer:app.secret,body:{capabilities:bad}})).status,400);
  const synced = await request(route+'/capabilities', {method:'PUT',bearer:app.secret,
    body:{capabilities,diagnostic:{version:'1.0.999',autonomous:true,previews_allowed:true,secret:'never expose'}}});
  assert.equal(synced.status,200);
  const rpc = async (name,args={}) => (await (await request('/mcp',{method:'POST',bearer:access_token,
    body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}})).json()).result;
  const listing=await rpc('apps_list');
  assert.equal(Array.isArray(listing.structuredContent),false);
  assert.equal(listing.structuredContent.apps[0].diagnostic.version,'1.0.999');
  assert.equal(JSON.stringify(listing).includes('never expose'),false);
  assert.ok(listing.structuredContent.apps[0].capabilities.some(c=>c.name==='files_transfer_read'));
  assert.equal((await rpc('chk_read',{name:'android_status'})).structuredContent.legacy_required,false);
  const task=(await rpc('task_submit',{app_id:app.id,action:'browser_capture'})).structuredContent;
  assert.equal(task.state,'queued');
  assert.equal((await (await request(route+'/poll',{bearer:app.secret})).json()).task.id,task.id);
  // Valid JPEG marker and a payload exceeding the old 32 KiB HTTP body limit.
  const jpeg=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(45000),Buffer.from([255,217])]).toString('base64');
  const result={task_id:task.id,result:{ok:true,message:JSON.stringify({jpeg_base64:jpeg,width:720,height:960})}};
  for(let i=0;i<2;i++)assert.equal((await request(route+'/result',{method:'POST',bearer:app.secret,body:result})).status,200);
  const completed=await rpc('task_get',{task_id:task.id});
  assert.equal(completed.structuredContent.state,'completed');
  assert.equal(completed.content[1].type,'image');
  assert.equal(completed.content[1].data,jpeg);
  assert.equal(JSON.stringify(completed.structuredContent).includes(jpeg),false);
  result.result.message='different result';
  assert.equal((await request(route+'/result',{method:'POST',bearer:app.secret,body:result})).status,400);
  const write=(await rpc('task_submit',{app_id:app.id,action:'files_transfer_write',args:{base64:'a'.repeat(65000)}})).structuredContent;
  assert.equal(write.state,'pending_approval');
});
