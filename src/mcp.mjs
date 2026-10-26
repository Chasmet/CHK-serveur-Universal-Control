const tools = [
  { name: "server_status", title: "Etat CHK Universal", description: "Informations non sensibles sur le serveur et le moteur IA.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "apps_list", title: "Applications connectees", description: "Lister les applications enregistrées et les capacités exposées.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "app_register", title: "Enregistrer application", description: "Enregistre une application avec capacités déclarées. Retourne une clé privée UNE SEULE FOIS; ne la publiez jamais.", inputSchema: { type: "object", required: ["name", "capabilities"], properties: { name: { type: "string" }, capabilities: { type: "array", items: { type: "object", required: ["name", "readOnly"], properties: { name: { type: "string" }, description: { type: "string" }, readOnly: { type: "boolean" } } } } } } },
  { name: "app_invite", title: "Invitation application", description: "Génère une invitation unique de 15 minutes pour qu’une nouvelle application s’enregistre sans donner le mot de passe principal.", inputSchema: { type: "object", properties: {} } },
  { name: "task_submit", title: "Envoyer une commande", description: "Envoie une action vers une application enregistrée. Les actions d'écriture requièrent approbation explicite; l'état queued n'est pas completed.", inputSchema: { type: "object", required: ["app_id", "action"], properties: { app_id: { type: "string" }, action: { type: "string" }, args: { type: "object" }, request_id: { type: "string" } } } },
  { name: "task_get", title: "Etat de tâche", description: "Lire le résultat réel ou l'état d'une tâche.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } }, readOnlyHint: true },
  { name: "task_cancel", title: "Annuler commande", description: "Annule une tâche encore non exécutée.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } } },
  { name: "ai_chat", title: "Assistant Qwen open source", description: "Pose une question au modèle local via Ollama et orchestre des outils disponibles. Modèle externe optionnel.", inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } } } },
  { name: "crypto_status", title: "CHK Crypto sur Android", description: "Etat du CHK Crypto appairé, en ligne et outils visuels déclarés.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "crypto_capture", title: "Voir CHK Crypto", description: "Demande une capture JPEG de CHK Crypto, exclusivement si l'utilisateur a activé Accessibilité et vision. Retourne un task_id à suivre.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "crypto_inspect", title: "Lire les contrôles CHK Crypto", description: "Analyse les boutons et leurs positions sur l'écran CHK Crypto ouvert. Retourne task_id.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "crypto_action", title: "Contrôler CHK Crypto", description: "Appui, souris, balayage, saisie de texte ou retour Android, uniquement dans CHK Crypto après activation volontaire du service Accessibilité. Aucun ordre ni secret autorisé; retourne task_id, ne pas confondre queued et completed.", inputSchema: { type: "object", required: ["action"], properties: { action: {type:"string", enum:["ui_tap","ui_click","ui_long_press","ui_swipe","ui_type","ui_back"]}, args:{type:"object"}, request_id:{type:"string"} } } },
  { name: "crypto_result", title: "Résultat écran CHK Crypto", description: "Récupère l'état réel d'une tâche et son image JPEG si capture terminée.", inputSchema: { type: "object", required:["task_id"], properties: {task_id:{type:"string"}} }, readOnlyHint: true },
  { name: "chk_read", title: "CHK existant: lecture", description: "Interroge uniquement server_info ou android_status de la passerelle MCP CHK existante, si configurée.", inputSchema: { type: "object", properties: { name: { type: "string", enum: ["server_info", "android_status"] } } }, readOnlyHint: true }
];
const textResult = value => {
  const obj = Array.isArray(value) ? { items: value } : value && typeof value === "object" ? value : { value };
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj,
    isError: Boolean(obj.error || obj.state === "failed") };
};
function browserResult(job, store) {
  if (job?.state !== "completed" || store.state.apps[job.app_id]?.name !== "CHK Agent Browser Android · Local 3")
    return textResult(job);
  let payload;
  try { payload = JSON.parse(job.result?.message); } catch { return textResult(job); }
  const jpeg = payload?.jpeg_base64;
  if (typeof jpeg !== "string" || jpeg.length > 190000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(jpeg)
      || !Buffer.from(jpeg, "base64").subarray(0, 3).equals(Buffer.from([255,216,255])))
    return textResult(job);
  const { jpeg_base64, ...meta } = payload;
  const safe = { ...job, result: { ...job.result, message: meta } };
  return { content: [{ type: "text", text: JSON.stringify(safe) },
    { type: "image", mimeType: "image/jpeg", data: jpeg }], structuredContent: safe, isError: false };
}
function exposedTools() {
  return tools.map(({ readOnlyHint, ...tool }) => ({
    ...tool,
    annotations: { readOnlyHint: Boolean(readOnlyHint), destructiveHint: !readOnlyHint, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: [readOnlyHint ? "mcp:read" : "mcp:write"] }]
  }));
}
export function createMCP(config, store, security, ai, legacyCall, approveTask) {
  const writeTools = new Set(["app_register", "app_invite", "task_submit", "task_cancel", "ai_chat", "crypto_action"]);
  return async function handle(rpc, req, res) {
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || Array.isArray(rpc)) {
      return security.json(res, 400, { jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
    }
    const need = rpc.method === "tools/call" && writeTools.has(rpc.params?.name) ? "mcp:write" : "mcp:read";
    if (!security.verify(security.bearer(req), need)) return security.unauthorized(res, need);
    if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
    let result;
    try {
      if (rpc.method === "initialize") {
        result = { protocolVersion: ["2026-07-28", "2025-11-25", "2025-06-18"].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "CHK Universal Control", version: "0.1.0" } };
      } else if (rpc.method === "ping") result = {};
      else if (rpc.method === "tools/list") result = { tools: exposedTools() };
      else if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        const a = rpc.params?.arguments || {};
        let output;
        const browserApp = () => store.listApps(false)
          .filter(v => v.name === "CHK Agent Browser Android · Local 3")
          .sort((a,b) => Number(b.online) - Number(a.online) || Number(b.registered_at) - Number(a.registered_at))[0];
        const cryptoApp = () => store.listApps(false)
          .filter(v => v.name === "CHK Crypto Analyse 2"
            && v.capabilities?.some(c => c.name === "ui_status"))
          .sort((a,b) => Number(b.online) - Number(a.online)
            || Number(b.registered_at) - Number(a.registered_at))[0];
        if (name === "crypto_status") {
          const app = cryptoApp();
          output = app ? { ok: true, app_id: app.id, online: app.online, last_seen: app.last_seen,
            capabilities: app.capabilities.filter(c => c.name.startsWith("ui_")).map(c => c.name) }
            : { error: "crypto_visual_capabilities_not_registered" };
        }
        else if (name === "crypto_capture" || name === "crypto_inspect" || name === "crypto_action") {
          const app = cryptoApp();
          if (!app) output = { error: "crypto_visual_capabilities_not_registered" };
          else {
            const action = name === "crypto_capture" ? "ui_capture"
              : name === "crypto_inspect" ? "ui_inspect" : a.action;
            if (!app.capabilities.some(c => c.name === action)) output = { error: "capability_not_registered" };
            else output = await store.submit({ app_id: app.id, action, args: name === "crypto_action" ? (a.args || {}) : {},
              request_id: a.request_id || "", source:"mcp" });
          }
        }
        else if (name === "crypto_result") {
          output = store.getJob(a.task_id) || { error: "task_not_found" };
        }
        else if (name === "server_status") output = { service: "CHK Universal Control", status: "running", apps: store.listApps(Boolean(config.legacyUrl)).length, ai_configured: Boolean(config.ollamaUrl), legacy_configured: Boolean(config.legacyUrl), browser_connected: Boolean(browserApp()?.online), browser_protocol: 2 };
        else if (name === "apps_list") output = { apps: store.listApps(Boolean(config.legacyUrl)) };
        else if (name === "app_register") output = await store.registerApp(a);
        else if (name === "app_invite") output = await store.createInvite();
        else if (name === "task_submit") output = await store.submit({ ...a, source: "mcp", legacy: Boolean(config.legacyUrl) });
        else if (name === "task_get") output = store.getJob(a.task_id) || { error: "task_not_found" };
        else if (name === "task_cancel") output = await store.cancel(a.task_id);
        else if (name === "ai_chat") output = await ai.chat(a.message);
        else if (name === "chk_read") output = !["server_info", "android_status"].includes(a.name || "android_status") ? { error: "forbidden_read_tool" } : config.legacyUrl ? await legacyCall(a.name || "android_status", {}) : browserApp()
          ? { connection: "paired_worker", app: browserApp(), legacy_required: false }
          : { error: "browser_not_paired", legacy_required: false };
        else return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown tool" } });
        if (name === "crypto_result" && output?.state === "completed"
              && output?.action === "ui_capture" && output?.result?.jpegBase64) {
          const { jpegBase64, ...meta } = output.result;
          const safe = { ...output, result: meta };
          result = {
            content: [
              { type: "text", text: JSON.stringify(safe) },
              { type: "image", mimeType: "image/jpeg", data: jpegBase64 }
            ],
            structuredContent: safe,
            isError: false
          };
        } else if (name === "task_get") result = browserResult(output, store);
        else result = textResult(output);
      } else return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
      return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
    } catch (err) {
      return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: textResult({ error: err.message || "internal_error" }) });
    }
  };
}
