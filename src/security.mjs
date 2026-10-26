import { randomBytes, createHmac, createHash } from "node:crypto";
import { clean, hash, now, safeEqual, uid } from "./core.mjs";

const json = (res, code, body, extra = {}) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(JSON.stringify(body));
};
const escapeHtml = x => String(x).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const enc = x => Buffer.from(JSON.stringify(x)).toString("base64url");
const sign = (text, key) => createHmac("sha256", key).update(text).digest("base64url");

export function createSecurity(config, store) {
  const issuer = config.base;
  const resource = config.base + "/mcp";
  const scope = "mcp:read mcp:write";
  const failures = new Map();
  const chatgptUris = [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    /^https:\/\/chatgpt\.com\/connector\/oauth\/[a-zA-Z0-9_-]{6,160}$/
  ];
  const allowedUri = uri => {
    try {
      const u = new URL(uri);
      if (u.username || u.password || u.hash) return false;
      return chatgptUris.some(pattern => typeof pattern === "string" ? uri === pattern : pattern.test(uri))
        || (config.allowLocalOAuth && u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname) && !u.pathname.includes(".."));
    } catch { return false; }
  };
  const token = (sub = "owner", requestedScope = scope) => {
    const payload = { sub, aud: resource, iss: issuer, iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 3600, scope: requestedScope };
    const unsigned = enc({ typ: "JWT", alg: "HS256" }) + "." + enc(payload);
    return unsigned + "." + sign(unsigned, config.jwtSecret);
  };
  function verify(jwt, needed = "mcp:read") {
    if (!jwt || typeof jwt !== "string") return false;
    const parts = jwt.split(".");
    if (parts.length !== 3 || parts.some(p => !p)) return false;
    const unsigned = parts[0] + "." + parts[1];
    if (!safeEqual(parts[2], sign(unsigned, config.jwtSecret))) return false;
    try {
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return header.alg === "HS256" && claims.iss === issuer && claims.aud === resource && claims.sub === "owner" &&
        claims.exp > Math.floor(now() / 1000) && claims.iat <= Math.floor(now() / 1000) &&
        typeof claims.scope === "string" && claims.scope.split(" ").includes(needed);
    } catch { return false; }
  }
  function bearer(req) {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
    return m ? m[1] : null;
  }
  function unauthorized(res, needed = "mcp:read") {
    json(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer resource_metadata="' + issuer + '/.well-known/oauth-protected-resource", scope="' + needed + '"' });
  }
  function validateQuery(query) {
    const clientId = query.get("client_id");
    const redirect = query.get("redirect_uri");
    const codeChallenge = query.get("code_challenge");
    const client = store.state.clients[clientId];
    if (query.get("response_type") !== "code" || !client || !client.redirect_uris.includes(redirect) ||
        !allowedUri(redirect) || query.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge || "") || query.get("resource") !== resource ||
        (query.get("scope") && query.get("scope").split(" ").some(s => !scope.split(" ").includes(s)))) throw Error("invalid_oauth_request");
    return { clientId, redirect, challenge: codeChallenge, requestedScope: query.get("scope") || scope };
  }
  const route = async (req, res, url, body) => {
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, { resource, authorization_servers: [issuer], scopes_supported: scope.split(" ") });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer, authorization_endpoint: issuer + "/oauth/authorize", token_endpoint: issuer + "/oauth/token",
        registration_endpoint: issuer + "/oauth/register", response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"], scopes_supported: scope.split(" "),
        authorization_response_iss_parameter_supported: true
      });
    }
    if (path === "/oauth/register" && req.method === "POST") {
      const input = body;
      const uris = input.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(allowedUri) ||
          (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== "none")) return json(res, 400, { error: "invalid_client_metadata" });
      const id = "chk_" + uid();
      await store.change(s => {
        if (Object.keys(s.clients).length >= 100) throw Error("client_limit");
        s.clients[id] = { redirect_uris: uris, client_name: clean(input.client_name, 80), created_at: now() };
      });
      return json(res, 201, { client_id: id, client_name: clean(input.client_name, 80), redirect_uris: uris, token_endpoint_auth_method: "none" });
    }
    if (path === "/oauth/authorize" && ["GET", "POST"].includes(req.method)) {
      let meta;
      try { meta = validateQuery(url.searchParams); }
      catch { return json(res, 400, { error: "invalid_oauth_request" }); }
      if (req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "x-frame-options": "DENY"
        });
        return res.end('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CHK — Autoriser ChatGPT</title><style>body{font:16px sans-serif;max-width:480px;margin:7vh auto;padding:24px;background:#111827;color:#fff}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:10px 0}button{background:#2563eb;color:white;border:0;cursor:pointer}button:disabled{opacity:.5}#feedback{min-height:2em;color:#bfe5ff;white-space:pre-wrap}</style><h1>CHK Universal Control</h1><p>Autoriser ChatGPT à consulter et commander les applications ? Les actions sensibles nécessiteront une confirmation.</p><form id="chk-oauth-form" method="POST"><label>Mot de passe administrateur<input name="password" type="password" required autocomplete="current-password"></label><button id="chk-oauth-button" type="submit">Autoriser ChatGPT</button><p id="feedback" role="status" aria-live="polite"></p></form><script src="/oauth-login.js" defer></script></html>');
      }
      const ip = req.socket.remoteAddress || "unknown";
      const attempts = failures.get(ip) || { count: 0, until: 0 };
      if (attempts.until > now()) return json(res, 429, { error: "too_many_attempts" });
      if (!safeEqual(body.password || "", config.adminPassword)) {
        attempts.count++;
        attempts.until = attempts.count >= 5 ? now() + 10 * 60000 : 0;
        failures.set(ip, attempts);
        return json(res, 403, { error: "invalid_password" });
      }
      failures.delete(ip);
      const authCode = "chkc_" + uid();
      await store.change(s => {
        s.codes[hash(authCode)] = { ...meta, expires: now() + 5 * 60000 };
      });
      const redirectUrl = new URL(meta.redirect);
      redirectUrl.searchParams.set("code", authCode);
      if (url.searchParams.has("state")) redirectUrl.searchParams.set("state", url.searchParams.get("state"));
      redirectUrl.searchParams.set("iss", issuer);
      // The mobile OAuth form uses JSON to render a clear success or error
      // instead of silently waiting for a cross-site redirect to complete.
      // A non-JS browser still receives the standard OAuth 302 response.
      if ((req.headers.accept || "").includes("application/json")) {
        return json(res, 200, { redirect_to: redirectUrl.href });
      }
      res.writeHead(302, { location: redirectUrl.href, "cache-control": "no-store", referrerPolicy: "no-referrer" });
      return res.end();
    }
    if (path === "/oauth/token" && req.method === "POST") {
      if (body.grant_type === "authorization_code") {
        const saved = store.state.codes[hash(body.code || "")];
        if (!saved || saved.expires < now() || saved.clientId !== body.client_id || saved.redirect !== body.redirect_uri ||
            body.resource !== resource || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier || "")) return json(res, 400, { error: "invalid_grant" });
        const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
        if (!safeEqual(saved.challenge, challenge)) return json(res, 400, { error: "invalid_grant" });
        const refresh = "chkr_" + uid() + uid();
        await store.change(s => {
          delete s.codes[hash(body.code)];
          s.refresh[hash(refresh)] = { clientId: saved.clientId, requestedScope: saved.requestedScope, expires: now() + 30 * 86400000 };
        });
        return json(res, 200, { access_token: token("owner", saved.requestedScope), token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: saved.requestedScope });
      }
      if (body.grant_type === "refresh_token") {
        const saved = store.state.refresh[hash(body.refresh_token || "")];
        if (!saved || saved.expires < now() || saved.clientId !== body.client_id || body.resource !== resource) return json(res, 400, { error: "invalid_grant" });
        const refresh = "chkr_" + uid() + uid();
        await store.change(s => {
          delete s.refresh[hash(body.refresh_token)];
          s.refresh[hash(refresh)] = saved;
        });
        return json(res, 200, { access_token: token("owner", saved.requestedScope), token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: saved.requestedScope });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    return false;
  };
  return { route, token, verify, bearer, unauthorized, json, resource };
}
