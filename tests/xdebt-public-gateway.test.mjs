import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.mjs";
import { createXDebtPublicGateway } from "../src/xdebt-public-gateway.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "xdebt-public-"));
  const { server: universal } = await buildServer({
    host: "127.0.0.1", port: 0, base: "http://localhost:8787",
    adminPassword: "local-test-long-password-1234567",
    jwtSecret: "x".repeat(64),
    file: join(directory, "server.json"),
    xdebtFile: join(directory, "xdebt.json"),
    ollamaUrl: "", legacyUrl: ""
  });
  await new Promise(resolve => universal.listen(0, "127.0.0.1", resolve));
  const port = universal.address().port;
  const gateway = createXDebtPublicGateway({ upstreamPort: port, port: 8798 });
  await new Promise(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => gateway.server.close(resolve));
    await new Promise(resolve => universal.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + gateway.server.address().port;
  const request = async (path, method = "GET", body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { request, universal, base };
}

test("XDebt gateway forwards only XDebt paths; MCP, OAuth, and owner APIs never exposed", async t => {
  const { request } = await fixture(t);
  assert.deepEqual((await request("/xdebt/api/health")).body, {
    status: "ok", service: "XDebt", payments_enabled: false, api_version: 1
  });
  for (const path of ["/mcp", "/chat", "/health", "/oauth/token", "/api/apps", "/api/login",
    "/xdebt/api/health?extra=1", "/xdebt/api/../../../mcp", "/xdebt/api/unknown"]) {
    const result = await request(path);
    assert.equal(result.status, 404, path);
    assert.equal(result.body.error, "not_found");
  }
  assert.equal((await request("/xdebt/api/health", "POST", {})).status, 404);
  assert.equal((await request("/xdebt/api/register", "GET")).status, 404);
  assert.equal((await request("/xdebt/api/register", "POST", undefined)).status, 415);
});

test("XDebt gateway registers accounts, enforces private invoices, Bearer auth and 3 custom folders", async t => {
  const { request } = await fixture(t);
  const signup = await request("/xdebt/api/register", "POST", {
    display_name: "Tester", email: "tester@example.test", password: "my-strong-password"
  });
  assert.equal(signup.status, 201);
  const token = signup.body.token;
  assert.ok(token.length >= 32);
  const auth = { authorization: "Bearer " + token };
  const id = signup.body.profile.id;
  assert.equal(signup.body.profile.folders.length, 9);
  assert.equal((await request("/xdebt/api/me")).status, 401);
  const invoice = await request("/xdebt/api/me/invoices", "POST", {
    folder_key: "electricite", label: "Facture mensuelle", amount_cents: 9900,
    due_date: "", is_public: false
  }, auth);
  assert.equal(invoice.status, 201);
  const mine = await request("/xdebt/api/me", "GET", undefined, auth);
  assert.equal(mine.body.profile.total_cents, 9900);
  const shared = await request("/xdebt/api/profiles/" + id);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.profile.total_cents, 0);
  assert.equal(shared.body.profile.email, undefined);
  assert.equal((await request("/xdebt/api/login", "POST", {
    email: "tester@example.test", password: "my-strong-password"
  })).status, 200);
  for (let i = 0; i < 3; i++) {
    assert.equal((await request("/xdebt/api/me/folders", "POST", { name: "Perso " + i }, auth)).status, 201);
  }
  assert.equal((await request("/xdebt/api/me/folders", "POST", { name: "Too many" }, auth)).status, 409);
  assert.equal((await request("/xdebt/api/me", "GET", undefined, auth)).body.profile.folders.length, 12);
  assert.equal((await request("/xdebt/api/logout", "POST", {}, auth)).status, 200);
  assert.equal((await request("/xdebt/api/me", "GET", undefined, auth)).status, 401);
});

test("XDebt gateway fails closed for oversize content and untrusted headers", async t => {
  const { base } = await fixture(t);
  const res = await fetch(base + "/xdebt/api/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.2" },
    body: JSON.stringify({ display_name: "A", email: "a@example.test", password: "p".repeat(181000) })
  });
  assert.equal(res.status, 413);
  const head = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(head.status, 404);
  assert.equal(head.headers.get("access-control-allow-origin"), null);
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.throws(() => createXDebtPublicGateway({host:"0.0.0.0"}), /gateway_must_listen_on_loopback/);
});
