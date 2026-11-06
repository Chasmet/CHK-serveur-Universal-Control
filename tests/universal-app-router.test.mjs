import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.mjs";
import { createApplicationRouter } from "../src/app-router.mjs";

test("one Universal process serves legacy health and isolated XDebt routes on same port", async t => {
  const directory = await mkdtemp(join(tmpdir(), "universal-multiapp-"));
  const config = {
    host: "127.0.0.1", port: 0, base: "http://localhost:8787",
    adminPassword: "test-admin-password-2026", jwtSecret: "a".repeat(64),
    file: join(directory, "server.json"), xdebtFile: join(directory, "xdebt.json"),
    ollamaUrl: "", legacyUrl: ""
  };
  const { server } = await buildServer(config);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = "http://127.0.0.1:" + server.address().port;
  const universal = await fetch(url + "/health").then(r => r.json());
  assert.equal(universal.service, "CHK Universal Control");
  const app = await fetch(url + "/xdebt/api/health").then(r => r.json());
  assert.equal(app.service, "XDebt");
  assert.equal(app.payments_enabled, false);
  const a = await fetch(url + "/api/apps");
  assert.equal(a.status, 401);
  const mcp = await fetch(url + "/mcp", { method: "GET" });
  assert.equal(mcp.status, 405);
  const auth = await fetch(url + "/xdebt/api/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Marie", email: "marie@example.test", password: "longpasswort-2026" })
  });
  assert.equal(auth.status, 201);
  const token = (await auth.json()).token;
  assert.ok(token.length >= 32);
  const me = await fetch(url + "/xdebt/api/me", { headers: { authorization: "Bearer " + token }});
  assert.equal(me.status, 200);
  assert.equal((await me.json()).profile.folders.length, 9);
});

test("the app router reserves old namespaces and isolates per-app paths", async t => {
  const directory = await mkdtemp(join(tmpdir(), "multiapp-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const router = await createApplicationRouter({ file: join(directory,"core.json") });
  assert.deepEqual(router.apps(), [{ id: "xdebt", prefix: "/xdebt/api" }]);
  for (const path of ["/mcp", "/oauth", "/api/login", "/health", "/chat", "/xdebt/api-v2/login", "/xdebt/apiary"])
    assert.equal(router.isApplicationPath(path), false, path);
  for (const path of ["/xdebt/api", "/xdebt/api/health", "/xdebt/api/register"])
    assert.equal(router.isApplicationPath(path), true, path);
  assert.equal(router.bodyLimit("/xdebt/api/register"), 180000);
  assert.equal(router.bodyLimit("/mcp"), 32768);
});
