import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.mjs";
import { Store } from "../src/core.mjs";
import { createGodotBridge } from "../src/godot.mjs";

test("Pirate Warrior 2 is a local first-party application with approval required", async t => {
  const home = await mkdtemp(join(tmpdir(), "chk-pirate-first-app-"));
  t.after(async () => rm(home, { force: true, recursive: true }));
  const store = await new Store(join(home, "server.json")).init();
  const first = store.listApps().find(app => app.id === "godot-local");
  assert.equal(first.name, "Pirate Warrior 2 (Godot local)");
  assert.equal(first.connection, "first_party_local");
  assert.ok(!("secret" in first));
  assert.ok(first.capabilities.some(c => c.name === "godot_batch" && !c.readOnly));
  const task = await store.submit({ app_id: "godot-local", action: "godot_run", args: { method: "scene.get_tree" } });
  assert.equal(task.state, "pending_approval");
  await assert.rejects(store.poll("godot-local"), /unknown_app/);
  assert.equal((await store.approve(task.id)).state, "queued");
  assert.equal((await store.markLegacy(task.id, null, "leased")).state, "leased");
  assert.equal((await store.markLegacy(task.id, { error: "editor_offline" }, "unknown")).state, "unknown");
});

test("Godot bridge never contacts arbitrary remote addresses or returns secrets", async () => {
  assert.throws(() => createGodotBridge({ url: "https://elsewhere.example" }), /godot_local_only/);
  const bridge = createGodotBridge({ settings: join(tmpdir(), "not-a-real-chk-config-2026.json") });
  const response = await bridge.status();
  assert.equal(response.application, "Pirate Warrior 2");
  assert.equal(response.ok, false);
  assert.ok(!JSON.stringify(response).includes("chat_token"));
});

test("Universal MCP exposes Godot tools and queues writes instead of claiming success", async t => {
  const folder = await mkdtemp(join(tmpdir(), "chk-mcp-godot-"));
  const { server } = await buildServer({
    base: "http://localhost:8787", host: "127.0.0.1", port: 0,
    adminPassword: "some-long-random-password", jwtSecret: "z".repeat(64),
    file: join(folder, "storage.json"), legacyUrl: "", ollamaUrl: ""
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { force: true, recursive: true }); });
  const login = await fetch(root + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "some-long-random-password" }) });
  const auth = (await login.json()).access_token;
  const rpc = async (method, params) => {
    const response = await fetch(root + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + auth }, body: JSON.stringify({ jsonrpc: "2.0", id: 23, method, params }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const discovered = await rpc("tools/list", {});
  assert.ok(discovered.tools.some(t => t.name === "godot_run"));
  const response = await rpc("tools/call", { name: "godot_run", arguments: { method: "scene.get_tree" } });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.app_id, "godot-local");
  assert.equal(payload.state, "pending_approval");
  assert.equal(payload.result, null);
  const apps = await rpc("tools/call", { name: "apps_list", arguments: {} });
  assert.ok(JSON.parse(apps.content[0].text).some(app => app.id === "godot-local"));
});
