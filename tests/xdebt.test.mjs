import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "xdebt-test-"));
  const options = { host: "127.0.0.1", port: 0, base: "http://localhost:8787",
    adminPassword: "very-long-test-password-999", jwtSecret: "z".repeat(64),
    file: join(dir, "main.json"), xdebtFile: join(dir, "xdebt.json"), ollamaUrl: "", legacyUrl: "" };
  const { server } = await buildServer(options);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const request = async (path, method = "GET", data, token = "") => {
    const response = await fetch(origin + "/xdebt/api" + path, {
      method, headers: { ...(data ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, origin };
}
test("XDebt private by default, public profiles, 9 fixed + 3 custom maximum", async t => {
  const { request, origin } = await fixture(t);
  assert.equal((await (await fetch(origin + "/health")).json()).service, "CHK Universal Control");
  const health = await request("/health");
  assert.equal(health.body.payments_enabled, false);
  const reg = await request("/register", "POST", { display_name: "Camille", email: "camille@example.test", password: "strong-password-2026" });
  assert.equal(reg.status, 201);
  const token = reg.body.token;
  const id = reg.body.profile.id;
  assert.equal(reg.body.profile.folders.length, 9);
  const privateInvoice = await request("/me/invoices", "POST",
    { folder_key: "electricite", label: "Facture EDF novembre", amount_cents: 12990, due_date: "2026-11-15", is_public: false }, token);
  assert.equal(privateInvoice.status, 201);
  assert.equal((await request("/me", "GET", null, token)).body.profile.total_cents, 12990);
  assert.equal((await request("/profiles/" + id)).body.profile.total_cents, 0);
  assert.equal((await request("/profiles")).body.profiles[0].visible_invoice_count, 0);
  const shared = await request("/me/invoices", "POST",
    { folder_key: "maison", label: "Loyer novembre", amount_cents: 45000, due_date: "", is_public: true }, token);
  assert.equal(shared.status, 201);
  assert.equal((await request("/profiles/" + id)).body.profile.total_cents, 45000);
  for (let i = 0; i < 3; i++) assert.equal((await request("/me/folders", "POST", { name: "Perso " + i }, token)).status, 201);
  assert.equal((await request("/me/folders", "POST", { name: "Quatrième" }, token)).status, 409);
  assert.equal((await request("/me", "GET", null, token)).body.profile.folders.length, 12);
  assert.equal((await request("/me", "GET")).status, 401);
  assert.equal((await request("/me/invoices/" + privateInvoice.body.invoice.id, "DELETE", null, token)).status, 200);
  assert.equal((await request("/me", "GET", null, token)).body.profile.total_cents, 45000);
  assert.equal((await request("/register", "POST", { display_name: "Camille", email: "camille@example.test", password: "another-long-password" })).status, 409);
  assert.equal((await request("/login", "POST", { email: "camille@example.test", password: "wrong-password" })).status, 401);
  assert.equal((await request("/login", "POST", { email: "camille@example.test", password: "strong-password-2026" })).status, 200);
  assert.equal((await request("/logout", "POST", {}, token)).status, 200);
  assert.equal((await request("/me", "GET", null, token)).status, 401);
});
