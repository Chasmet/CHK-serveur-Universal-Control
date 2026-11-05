import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const XDEBT_CATEGORIES = Object.freeze([
  ["electricite", "Électricité"], ["eau", "Eau"], ["gaz", "Gaz"],
  ["maison", "Maison / Loyer"], ["internet", "Internet / Téléphone"], ["sante", "Santé"],
  ["transport", "Transport / Auto"], ["education", "Éducation"], ["credit", "Crédit / Dettes"]
]);
const sha = value => createHash("sha256").update(value).digest("hex");
const trim = (v, max) => String(v ?? "").trim().slice(0, max);
const issue = (status, error) => Object.assign(new Error(error), { status });
const sessionDays = 30 * 86400000;
const empty = () => ({ users: {}, sessions: {}, invoices: {} });
const passwordHash = (secret, salt) => scryptSync(secret, salt, 64).toString("hex");
const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 190;

export class XDebtService {
  constructor(file) {
    this.file = file;
    this.data = empty();
    this.pending = Promise.resolve();
    this.attempts = new Map();
  }
  async init() {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      this.data = { ...empty(), ...data };
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    return this;
  }
  async save(fn) {
    const next = this.pending.then(async () => {
      const output = fn(this.data);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = this.file + "." + randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify(this.data), { mode: 0o600 });
      await rename(temp, this.file);
      return output;
    });
    this.pending = next.catch(() => {});
    return next;
  }
  throttle(req) {
    const key = String(req.socket.remoteAddress || "unknown");
    const now = Date.now();
    const old = this.attempts.get(key) || { count: 0, until: now + 600000 };
    if (old.until < now) { old.count = 0; old.until = now + 600000; }
    old.count++;
    this.attempts.set(key, old);
    if (old.count > 30) throw issue(429, "too_many_auth_attempts");
  }
  authenticated(req) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1] || "";
    const session = this.data.sessions[sha(token)];
    if (!token || !session || session.until < Date.now()) throw issue(401, "authentication_required");
    const user = this.data.users[session.user_id];
    if (!user) throw issue(401, "authentication_required");
    return user;
  }
  categories(user, includePrivate = false) {
    const defs = [...XDEBT_CATEGORIES.map(([key, name]) => ({ key, name, custom: false })),
      ...(user.custom_folders || []).map(f => ({ ...f, custom: true }))];
    return defs.map(folder => {
      const invoices = Object.values(this.data.invoices).filter(inv =>
        inv.user_id === user.id && inv.folder_key === folder.key && (includePrivate || inv.is_public))
        .map(({ id, label, amount_cents, due_date, is_public, created_at }) =>
          ({ id, label, amount_cents, due_date, is_public, created_at }));
      return { ...folder, invoices, total_cents: invoices.reduce((sum, item) => sum + item.amount_cents, 0) };
    });
  }
  profile(user, privateView = false) {
    const folders = this.categories(user, privateView);
    const total = folders.reduce((sum, f) => sum + f.total_cents, 0);
    return { id: user.id, display_name: user.display_name, bio: user.bio || "", avatar: user.avatar || "",
      joined_at: user.joined_at, folders, total_cents: total, collected_cents: 0,
      remaining_cents: total, ...(privateView ? { email: user.email } : {}) };
  }
  async handle(req, res, url, body, json) {
    try {
      const path = url.pathname.substring("/xdebt/api".length);
      if (req.method === "GET" && path === "/health")
        return json(res, 200, { status: "ok", service: "XDebt", payments_enabled: false, api_version: 1 });
      if (req.method === "POST" && path === "/register") {
        this.throttle(req);
        const display_name = trim(body.display_name, 60);
        const email = trim(body.email, 190).toLowerCase();
        const password = String(body.password || "");
        if (display_name.length < 2 || !validEmail(email) || password.length < 10 || password.length > 200)
          throw issue(400, "invalid_registration");
        if (Object.values(this.data.users).some(u => u.email === email))
          throw issue(409, "email_already_registered");
        const id = randomUUID();
        const salt = randomBytes(16).toString("hex");
        const token = randomBytes(32).toString("base64url");
        await this.save(data => {
          if (Object.values(data.users).some(u => u.email === email)) throw issue(409, "email_already_registered");
          data.users[id] = { id, email, display_name, salt, password_hash: passwordHash(password, salt),
            bio: "", avatar: "", custom_folders: [], joined_at: new Date().toISOString() };
          data.sessions[sha(token)] = { user_id: id, until: Date.now() + sessionDays };
        });
        return json(res, 201, { token, profile: this.profile(this.data.users[id], true) });
      }
      if (req.method === "POST" && path === "/login") {
        this.throttle(req);
        const email = trim(body.email, 190).toLowerCase();
        const password = String(body.password || "");
        const user = Object.values(this.data.users).find(u => u.email === email);
        const computed = passwordHash(password, user?.salt || "f".repeat(32));
        if (!user || !timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(user.password_hash, "hex")))
          throw issue(401, "invalid_credentials");
        const token = randomBytes(32).toString("base64url");
        await this.save(data => { data.sessions[sha(token)] = { user_id: user.id, until: Date.now() + sessionDays }; });
        return json(res, 200, { token, profile: this.profile(user, true) });
      }
      if (req.method === "GET" && path === "/profiles") {
        const profiles = Object.values(this.data.users).sort((a, b) => b.joined_at.localeCompare(a.joined_at))
          .slice(0, 100).map(u => {
            const p = this.profile(u, false);
            const { folders, ...preview } = p;
            return { ...preview, visible_invoice_count: folders.reduce((s, f) => s + f.invoices.length, 0) };
          });
        return json(res, 200, { profiles });
      }
      const publicMatch = /^\/profiles\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === "GET" && publicMatch) {
        const user = this.data.users[publicMatch[1]];
        if (!user) throw issue(404, "profile_not_found");
        return json(res, 200, { profile: this.profile(user, false) });
      }
      const user = this.authenticated(req);
      if (path === "/me" && req.method === "GET")
        return json(res, 200, { profile: this.profile(user, true) });
      if (path === "/me" && req.method === "PATCH") {
        const display_name = trim(body.display_name ?? user.display_name, 60);
        const bio = trim(body.bio ?? user.bio, 500);
        if (display_name.length < 2) throw issue(400, "invalid_display_name");
        const avatar = body.avatar === undefined ? user.avatar : String(body.avatar || "");
        if (avatar && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(avatar) || avatar.length > 145000))
          throw issue(400, "invalid_avatar");
        await this.save(() => { user.display_name = display_name; user.bio = bio; user.avatar = avatar; });
        return json(res, 200, { profile: this.profile(user, true) });
      }
      if (path === "/me/folders" && req.method === "POST") {
        const name = trim(body.name, 40);
        if (name.length < 2) throw issue(400, "invalid_folder_name");
        if (user.custom_folders.length >= 3) throw issue(409, "custom_folder_limit");
        const key = "perso_" + randomUUID();
        await this.save(() => { user.custom_folders.push({ key, name }); });
        return json(res, 201, { profile: this.profile(user, true) });
      }
      if (path === "/me/invoices" && req.method === "POST") {
        const folder_key = trim(body.folder_key, 80);
        const label = trim(body.label, 120);
        const amount_cents = Number(body.amount_cents);
        const due_date = trim(body.due_date, 10);
        if (!this.categories(user, true).some(f => f.key === folder_key) || label.length < 3 ||
          !Number.isSafeInteger(amount_cents) || amount_cents < 1 || amount_cents > 100000000 ||
          (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) || typeof body.is_public !== "boolean")
          throw issue(400, "invalid_invoice");
        const record = { id: randomUUID(), user_id: user.id, folder_key, label,
          amount_cents, due_date, is_public: body.is_public, created_at: new Date().toISOString() };
        await this.save(data => { data.invoices[record.id] = record; });
        return json(res, 201, { invoice: record });
      }
      const deleteMatch = /^\/me\/invoices\/([a-f0-9-]{36})$/.exec(path);
      if (deleteMatch && req.method === "DELETE") {
        const inv = this.data.invoices[deleteMatch[1]];
        if (!inv || inv.user_id !== user.id) throw issue(404, "invoice_not_found");
        await this.save(data => { delete data.invoices[inv.id]; });
        return json(res, 200, { deleted: true });
      }
      if (path === "/logout" && req.method === "POST") {
        const token = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1] || "";
        await this.save(data => { delete data.sessions[sha(token)]; });
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not_found" });
    } catch (err) {
      return json(res, err.status || 500, { error: err.status ? err.message : "internal_error" });
    }
  }
}
