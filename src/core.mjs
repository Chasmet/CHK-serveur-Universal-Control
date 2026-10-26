import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const uid = () => randomBytes(18).toString("hex");
export const hash = value => createHash("sha256").update(value).digest("hex");
export const now = () => Date.now();
export const safeEqual = (a, b) => {
  const aa = Buffer.from(hash(String(a)));
  const bb = Buffer.from(hash(String(b)));
  return timingSafeEqual(aa, bb);
};
export const clean = (value, max = 120) => String(value ?? "").trim().slice(0, max);
const browserCapabilities = JSON.parse(readFileSync(new URL("./browser-capabilities.json", import.meta.url), "utf8"));
const browserName = "CHK Agent Browser Android · Local 3";
const jobStates = new Set(["pending_approval", "queued", "leased", "completed", "failed", "unknown", "cancelled"]);
const MAX_RESULT = 350000;

export class Store {
  constructor(file) {
    this.file = file;
    this.state = { apps: {}, jobs: {}, clients: {}, codes: {}, refresh: {}, invites: {}, version: 1 };
    this.lock = Promise.resolve();
  }
  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      this.state = { ...this.state, ...parsed };
      // Never execute an action again after a process crash with an uncertain outcome.
      for (const job of Object.values(this.state.jobs)) {
        if (job.state === "leased") job.state = "unknown";
      }
      await this.change(() => true);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      await this.change(() => true);
    }
    await this.ensureGodotApp();
    return this;
  }
  async ensureGodotApp() {
    if (this.state.apps["godot-local"]) return;
    await this.change(state => { state.apps["godot-local"] = {
      id: "godot-local", name: "Pirate Warrior 2 (Godot local)",
      capabilities: [
        { name: "godot_status", readOnly: true, description: "État de l’éditeur local" },
        { name: "godot_run", readOnly: false, description: "Commande Godot avec approbation" },
        { name: "godot_batch", readOnly: false, description: "Lot de commandes Godot avec approbation" }
      ],
      system: true, registered_at: now(), last_seen: null
    }; });
  }
  async change(fn) {
    const operation = this.lock.then(async () => {
      const result = fn(this.state);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = this.file + "." + uid() + ".tmp";
      await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
      return result;
    });
    this.lock = operation.catch(() => {});
    return operation;
  }
  listApps(legacy = false) {
    const apps = Object.values(this.state.apps).map(app => ({
      id: app.id, name: app.name, diagnostic: app.diagnostic, capabilities: app.capabilities, registered_at: app.registered_at,
      last_seen: app.last_seen, online: app.system ? null : Boolean(app.last_seen && now() - app.last_seen < 90000),
      connection: app.system ? "first_party_local" : "worker"
    }));
    if (legacy) apps.push({ id: "chk-legacy", name: "CHK Agent Browser (MCP existant)", capabilities: [{ name: "android_command", readOnly: false }], online: null, connection: "legacy" });
    return apps;
  }
  appsPage({ offset = 0, limit = 25, query = "", include_capabilities = true } = {}, allowed = null, legacy = false) {
    const page = this.page(this.listApps(legacy).filter(app => allowed === null || allowed.includes(app.id)), { offset, limit, query });
    if (include_capabilities === false) page.items = page.items.map(({ capabilities, ...app }) => ({ ...app, capability_count: capabilities.length }));
    const { items, ...meta } = page;
    return { apps: items, ...meta };
  }
  page(rows, { offset = 0, limit = 25, query = "" } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error("invalid_pagination");
    const needle = clean(query, 100).toLowerCase();
    const filtered = needle ? rows.filter(row => (row.id + " " + (row.name || "")).toLowerCase().includes(needle)) : rows;
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit,
      next_offset: offset + limit < filtered.length ? offset + limit : null };
  }
  connectorsPage(options = {}) {
    const rows = Object.entries(this.state.clients).map(([id, c]) => ({ id, name: c.label || c.client_name,
      enabled: c.enabled !== false, app_ids: c.app_ids ?? null, created_at: c.created_at }));
    const { items, ...meta } = this.page(rows, options);
    return { connectors: items, ...meta, max_registered: null };
  }
  async configureConnector(id, input) {
    const client = this.state.clients[id];
    if (!client) throw Error("unknown_connector");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw Error("invalid_connector_config");
    if (input.app_ids !== undefined && input.app_ids !== null && (!Array.isArray(input.app_ids) || input.app_ids.length > 100
        || input.app_ids.some(id => typeof id !== "string" || !this.state.apps[id]))) throw Error("invalid_connector_apps");
    await this.change(state => {
      const c = state.clients[id];
      if (input.name !== undefined) c.label = clean(input.name, 80);
      if (input.enabled !== undefined) c.enabled = input.enabled;
      if (input.app_ids !== undefined) c.app_ids = input.app_ids === null ? null : [...new Set(input.app_ids)];
    });
    const c = this.state.clients[id];
    return { id, name: c.label || c.client_name, enabled: c.enabled !== false, app_ids: c.app_ids ?? null };
  }
  async registerApp(input) {
    const name = clean(input.name, 80);
    if (!name) throw Error("app_name_required");
    const capabilities = input.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length > 80 || capabilities.some(c => !c || typeof c.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(c.name) || typeof c.readOnly !== "boolean")) {
      throw Error("invalid_capabilities");
    }
    const secret = "chkapp_" + randomBytes(32).toString("base64url");
    const app = { id: uid(), name, capabilities: capabilities.map(c => ({ name: c.name, readOnly: c.readOnly, description: clean(c.description, 150) })), secret_hash: hash(secret), registered_at: now(), last_seen: null };
    await this.change(s => {
      s.apps[app.id] = app;
    });
    return { id: app.id, name, secret, capabilities: app.capabilities };
  }
  async createInvite() {
    const secret = "chkinvite_" + randomBytes(24).toString("base64url");
    const expires = now() + 15 * 60000;
    await this.change(s => {
      for (const [key, value] of Object.entries(s.invites)) if (value.expires < now()) delete s.invites[key];
      s.invites[hash(secret)] = { expires };
    });
    return { invite: secret, expires_at: new Date(expires).toISOString(), one_time: true };
  }
  async joinApp(input) {
    const name = clean(input.name, 80);
    const capabilities = input.capabilities;
    if (!name || !Array.isArray(capabilities) || capabilities.length > 80 ||
        capabilities.some(c => !c || typeof c.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(c.name) || typeof c.readOnly !== "boolean")) throw Error("invalid_registration");
    const secret = "chkapp_" + randomBytes(32).toString("base64url");
    const app = { id: uid(), name, capabilities: capabilities.map(c => ({ name: c.name, readOnly: c.readOnly, description: clean(c.description, 150) })), secret_hash: hash(secret), registered_at: now(), last_seen: null };
    await this.change(s => {
      const invite = s.invites[hash(String(input.invite || ""))];
      if (!invite || invite.expires < now()) throw Error("invalid_invite");
      delete s.invites[hash(input.invite)];
      s.apps[app.id] = app;
    });
    return { id: app.id, name, secret, capabilities: app.capabilities };
  }
  async extendCapabilities(id, input) {
    const source = input?.capabilities;
    if (!Array.isArray(source) || source.length > 80
        || new Set(source.map(c => c?.name)).size !== source.length
        || source.some(c => !c || typeof c.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(c.name)
          || typeof c.readOnly !== "boolean")) throw Error("invalid_capabilities");
    let count;
    await this.change(state => {
      const app = state.apps[id];
      if (!app || app.system) throw Error("unknown_app");
      const existing = new Map(app.capabilities.map(c => [c.name, c]));
      for (const c of source) if (existing.has(c.name) && existing.get(c.name).readOnly !== c.readOnly)
        throw Error("invalid_capability_policy");
      for (const c of source) existing.set(c.name, {name:c.name,readOnly:c.readOnly,description:clean(c.description,150)});
      if(existing.size>80) throw Error("capability_limit");
      app.capabilities=[...existing.values()];count=app.capabilities.length;
    });
    return {ok:true,id,capability_count:count};
  }
  async extendVisualCapabilities(id, input) {
    const allowed = new Set(["ui_status", "ui_inspect", "ui_capture",
      "ui_click", "ui_tap", "ui_long_press", "ui_swipe", "ui_type", "ui_back"]);
    const source = input?.capabilities;
    if (!Array.isArray(source) || source.length !== allowed.size
        || source.some(c => !c || !allowed.has(c.name)
          || typeof c.readOnly !== "boolean"
          || c.readOnly !== ["ui_status", "ui_inspect", "ui_capture"].includes(c.name))
        || new Set(source.map(c => c.name)).size !== allowed.size) throw Error("invalid_visual_capabilities");
    let updated;
    await this.change(state => {
      const app = state.apps[id];
      if (!app) throw Error("unknown_app");
      const existing = new Map(app.capabilities.map(c => [c.name, c]));
      for (const c of source) existing.set(c.name, {
        name: c.name, readOnly: c.readOnly, description: clean(c.description, 150)
      });
      if (existing.size > 80) throw Error("capability_limit");
      app.capabilities = [...existing.values()];
      updated = { ok: true, id: app.id, capability_count: app.capabilities.length };
    });
    return updated;
  }
  async extendBrowserCapabilities(id, input) {
    const expected = new Map(browserCapabilities.map(c => [c.name, c.readOnly]));
    const source = input?.capabilities;
    if (!Array.isArray(source) || source.length !== expected.size
        || new Set(source.map(c => c?.name)).size !== expected.size
        || source.some(c => !c || !expected.has(c.name) || c.readOnly !== expected.get(c.name)))
      throw Error("invalid_browser_capabilities");
    let updated;
    await this.change(state => {
      const app = state.apps[id];
      if (!app || app.name !== browserName) throw Error("invalid_browser_app");
      const existing = new Map(app.capabilities.map(c => [c.name, c]));
      for (const c of source) {
        if (existing.has(c.name) && existing.get(c.name).readOnly !== c.readOnly)
          throw Error("invalid_browser_policy");
      }
      for (const c of source) existing.set(c.name, {
        name: c.name, readOnly: c.readOnly, description: clean(c.description, 150)
      });
      if (existing.size > 80) throw Error("capability_limit");
      app.capabilities = [...existing.values()];
      const d = input.diagnostic || {};
      app.diagnostic = {
        protocol_version: 2, version: clean(d.version, 40),
        autonomous: d.autonomous === true, previews_allowed: d.previews_allowed === true,
        reported_at: now()
      };
      updated = { ok: true, id, capability_count: app.capabilities.length };
    });
    return updated;
  }
  appAuthorized(id, token) {
    const app = this.state.apps[id];
    return Boolean(app && typeof token === "string" && safeEqual(app.secret_hash, hash(token)));
  }
  async submit({ app_id, action, args = {}, request_id = "", source = "api", legacy = false, connector_id = null }) {
    if (typeof args !== "object" || !args || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args), "utf8") > 96000) throw Error("invalid_arguments");
    const app = this.state.apps[app_id];
    const capability = app?.capabilities.find(c => c.name === action);
    if (!capability && !(legacy && app_id === "chk-legacy" && action === "android_command")) throw Error("capability_not_registered");
    const rid = clean(request_id, 100);
    let result;
    await this.change(s => {
      if (rid) {
        const existing = Object.values(s.jobs).find(job => job.source === source && job.request_id === rid);
        if (existing) {
          if (existing.app_id !== app_id || existing.action !== action || JSON.stringify(existing.args) !== JSON.stringify(args)) throw Error("idempotency_conflict");
          result = existing;
          return;
        }
      }
      if (Object.keys(s.jobs).length >= 100000) throw Error("job_limit");
      // The Android owner opts into this restricted CHK-only accessibility session.
      // The APK enforces the on-device switch and rejects orders/secret fields.
      // Other app actions and all trading capabilities still require approval.
      const delegatedVisual = app?.name === "CHK Crypto Analyse 2"
        && /^ui_(?:click|tap|long_press|swipe|type|back)$/.test(action)
        && capability?.readOnly === false;
      const approval = !capability?.readOnly && !delegatedVisual;
      const task = { id: uid(), app_id, action, args, request_id: rid, source, connector_id, state: approval ? "pending_approval" : "queued", created_at: now(), updated_at: now(), attempts: 0, result: null };
      s.jobs[task.id] = task;
      result = task;
    });
    return this.publicJob(result);
  }
  publicJob(job) {
    if (!job || !jobStates.has(job.state)) return null;
    return { id: job.id, app_id: job.app_id, connector_id: job.connector_id || null, action: job.action, args: job.args, state: job.state, created_at: job.created_at, updated_at: job.updated_at, result: job.result, request_id: job.request_id };
  }
  getJob(id) { return this.publicJob(this.state.jobs[id]); }
  listJobs() { return Object.values(this.state.jobs).sort((a,b) => b.created_at-a.created_at).slice(0,100).map(job => this.publicJob(job)); }
  async approve(id) {
    let job;
    await this.change(s => {
      job = s.jobs[id];
      if (!job || job.state !== "pending_approval") throw Error("not_approvable");
      job.state = "queued";
      job.updated_at = now();
    });
    return this.publicJob(job);
  }
  async cancel(id) {
    let job;
    await this.change(s => {
      job = s.jobs[id];
      if (!job || !["queued", "pending_approval"].includes(job.state)) throw Error("cannot_cancel");
      job.state = "cancelled";
      job.updated_at = now();
    });
    return this.publicJob(job);
  }
  async poll(appId) {
    let result = null;
    await this.change(s => {
      const app = s.apps[appId];
      if (!app || app.system) throw Error("unknown_app");
      app.last_seen = now();
      const job = Object.values(s.jobs).find(j => j.app_id === appId && j.state === "queued");
      if (job) {
        job.state = "leased";
        job.attempts += 1;
        job.updated_at = now();
        result = { id: job.id, action: job.action, args: job.args };
      }
    });
    return result;
  }
  async result(appId, id, payload) {
    let job;
    await this.change(s => {
      job = s.jobs[id];
      if (!job || job.app_id !== appId) throw Error("invalid_job_result");
      if (["completed", "failed"].includes(job.state)
          && JSON.stringify(job.result) === JSON.stringify(payload)) return;
      if (job.state !== "leased") throw Error("invalid_job_result");
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_RESULT) throw Error("result_too_large");
      job.result = payload;
      job.state = payload?.ok === false ? "failed" : "completed";
      job.updated_at = now();
      s.apps[appId].last_seen = now();
    });
    return this.publicJob(job);
  }
  async markLegacy(id, value, state) {
    await this.change(s => {
      const job = s.jobs[id];
      if (!job || !["chk-legacy", "godot-local"].includes(job.app_id)) throw Error("not_builtin_job");
      if (job.state !== "queued" && !(job.state === "leased" && ["completed", "failed", "unknown"].includes(state))) throw Error("invalid_legacy_state");
      job.state = state;
      job.result = value;
      job.updated_at = now();
    });
    return this.getJob(id);
  }
}
