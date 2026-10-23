import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
const jobStates = new Set(["pending_approval", "queued", "leased", "completed", "failed", "unknown", "cancelled"]);
const MAX_RESULT = 12000;

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
    return this;
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
      id: app.id, name: app.name, capabilities: app.capabilities, registered_at: app.registered_at,
      last_seen: app.last_seen, online: Boolean(app.last_seen && now() - app.last_seen < 90000)
    }));
    if (legacy) apps.push({ id: "chk-legacy", name: "CHK Agent Browser (MCP existant)", capabilities: [{ name: "android_command", readOnly: false }], online: null, connection: "legacy" });
    return apps;
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
      if (Object.keys(s.apps).length >= 100) throw Error("app_limit");
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
      if (Object.keys(s.apps).length >= 100) throw Error("app_limit");
      delete s.invites[hash(input.invite)];
      s.apps[app.id] = app;
    });
    return { id: app.id, name, secret, capabilities: app.capabilities };
  }
  appAuthorized(id, token) {
    const app = this.state.apps[id];
    return Boolean(app && typeof token === "string" && safeEqual(app.secret_hash, hash(token)));
  }
  async submit({ app_id, action, args = {}, request_id = "", source = "api", legacy = false }) {
    if (typeof args !== "object" || !args || Array.isArray(args) || JSON.stringify(args).length > 16000) throw Error("invalid_arguments");
    const app = this.state.apps[app_id];
    const capability = app?.capabilities.find(c => c.name === action);
    if (!capability && !(legacy && app_id === "chk-legacy" && action === "android_command")) throw Error("capability_not_registered");
    const rid = clean(request_id, 100);
    let result;
    await this.change(s => {
      if (rid) {
        const existing = Object.values(s.jobs).find(job => job.source === source && job.request_id === rid);
        if (existing) {
          if (existing.app_id !== app_id || existing.action !== action) throw Error("idempotency_conflict");
          result = existing;
          return;
        }
      }
      if (Object.keys(s.jobs).length >= 5000) throw Error("job_limit");
      const approval = !capability?.readOnly;
      const task = { id: uid(), app_id, action, args, request_id: rid, source, state: approval ? "pending_approval" : "queued", created_at: now(), updated_at: now(), attempts: 0, result: null };
      s.jobs[task.id] = task;
      result = task;
    });
    return this.publicJob(result);
  }
  publicJob(job) {
    if (!job || !jobStates.has(job.state)) return null;
    return { id: job.id, app_id: job.app_id, action: job.action, state: job.state, created_at: job.created_at, updated_at: job.updated_at, result: job.result, request_id: job.request_id };
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
      if (!app) throw Error("unknown_app");
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
      if (!job || job.app_id !== appId || job.state !== "leased") throw Error("invalid_job_result");
      if (JSON.stringify(payload).length > MAX_RESULT) throw Error("result_too_large");
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
      if (!job || job.app_id !== "chk-legacy") throw Error("not_legacy_job");
      if (job.state !== "queued" && !(job.state === "leased" && ["completed", "failed", "unknown"].includes(state))) throw Error("invalid_legacy_state");
      job.state = state;
      job.result = value;
      job.updated_at = now();
    });
    return this.getJob(id);
  }
}
