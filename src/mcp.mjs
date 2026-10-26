import { SERVER_VERSION } from "./version.mjs";
import { cryptoTools } from "./crypto.mjs";
import { cryptoDeviceTools } from "./crypto-device-tools.mjs";
import { asReadOnly as cryptoMarketTools } from "./crypto-markets.mjs";
import { marketTools as advancedMarketTools } from "./crypto-market.mjs";
import { monitorTools } from "./crypto-monitor.mjs";

const pagination = { offset: {type:"integer",minimum:0}, limit:{type:"integer",minimum:1,maximum:100}, query:{type:"string"}, include_capabilities:{type:"boolean"} };
const tools = [
  { name:"connector_identity",title:"Identité de cette connexion",description:"Identifiant d’autorisation unique de ce connecteur et applications autorisées. Les anciens jetons seront identifiés après leur prochain renouvellement OAuth.",inputSchema:{type:"object",properties:{}},readOnlyHint:true },
  { name: "godot_status", title: "Pirate Warrior 2 - état", description: "Vérifie la connexion à l’éditeur Godot réel sur le PC, sans prétendre qu’une tâche est terminée.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "godot_run", title: "Pirate Warrior 2 - commande", description: "Prépare une commande Godot, à approuver dans le panneau local avant son exécution réelle.", inputSchema: { type: "object", required: ["method"], properties: { method: { type: "string" }, params: { type: "object" }, request_id: { type: "string" } } } },
  { name: "godot_batch", title: "Pirate Warrior 2 - commandes groupées", description: "Prépare 1 à 12 commandes Godot, à approuver avant exécution.", inputSchema: { type: "object", required: ["commands"], properties: { commands: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", required: ["method"], properties: { method: { type: "string" }, params: { type: "object" } } } }, request_id: { type: "string" } } } },
  { name: "server_status", title: "Etat CHK Universal", description: "Informations non sensibles sur le serveur et le moteur IA.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "apps_list", title: "Applications connectees", description: "Lister les applications autorisées et leurs capacités, par pages de 25 (maximum 100). Utiliser next_offset pour continuer ou query pour chercher un identifiant/nom.", inputSchema: { type: "object", properties: pagination }, readOnlyHint: true },
  { name: "app_register", title: "Enregistrer application", description: "Enregistre une application avec capacités déclarées. Retourne une clé privée UNE SEULE FOIS; ne la publiez jamais.", inputSchema: { type: "object", required: ["name", "capabilities"], properties: { name: { type: "string" }, capabilities: { type: "array", items: { type: "object", required: ["name", "readOnly"], properties: { name: { type: "string" }, description: { type: "string" }, readOnly: { type: "boolean" } } } } } } },
  { name: "app_invite", title: "Invitation application", description: "Génère une invitation unique de 15 minutes pour qu’une nouvelle application s’enregistre sans donner le mot de passe principal.", inputSchema: { type: "object", properties: {} } },
  { name: "task_submit", title: "Envoyer une commande", description: "Envoie une action vers une application enregistrée. Les actions d'écriture requièrent approbation explicite; l'état queued n'est pas completed.", inputSchema: { type: "object", required: ["action"], properties: { app_id: { type: "string" }, action: { type: "string" }, args: { type: "object" }, request_id: { type: "string" } } } },
  { name: "task_get", title: "Etat de tâche", description: "Lire le résultat réel ou l'état d'une tâche.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } }, readOnlyHint: true },
  { name: "task_cancel", title: "Annuler commande", description: "Annule une tâche encore non exécutée.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } } },
  { name: "ai_chat", title: "Assistant Qwen open source", description: "Pose une question au modèle local via Ollama et orchestre des outils disponibles. Modèle externe optionnel.", inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } } } },
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
  return [...tools,...cryptoTools,...cryptoDeviceTools,...cryptoMarketTools,...advancedMarketTools.filter(t=>!["crypto_orderbook","crypto_multi_timeframe"].includes(t.name)),...monitorTools,
    {name:"crypto_chart_state",title:"CHK Crypto — graphique Android réel",description:"Lit la paire, l'unité de temps, les indicateurs et le viewport enregistrés par le vrai graphique Android; la tâche peut être en attente.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
    {name:"crypto_device_status",title:"CHK Crypto — agent Android",description:"État du dispositif, de la connexion Internet et de l'agent MCP Android.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
    {name:"crypto_chart_control",title:"Piloter graphique CHK Crypto",description:"Modifie la paire, timeframe, profil, indicateurs, zoom ou pan de l'application Android uniquement après approbation locale. Aucune opération de trading.",inputSchema:{type:"object",required:["action"],properties:{action:{type:"string",enum:["set_symbol","set_timeframe","set_profile","set_indicators","zoom_in","zoom_out","pan_left","pan_right","go_to_latest","set_auto_scale"]},args:{type:"object"}}}}
  ].map(({ readOnlyHint, ...tool }) => ({
    ...tool,
    annotations: { readOnlyHint: Boolean(readOnlyHint), destructiveHint: !readOnlyHint, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: [readOnlyHint ? "mcp:read" : "mcp:write"] }]
  }));
}
export function createMCP(config, store, security, ai, legacyCall, approveTask, godot, crypto, markets, advancedMarket, monitor) {
  const writeTools = new Set(["app_register", "app_invite", "task_submit", "task_cancel", "ai_chat", "godot_run", "godot_batch", "crypto_chart_control", "crypto_monitor_config", "crypto_action"]);
  return async function handle(rpc, req, res) {
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || Array.isArray(rpc)) {
      return security.json(res, 400, { jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
    }
    const need = rpc.method === "tools/call" && writeTools.has(rpc.params?.name) ? "mcp:write" : "mcp:read";
    if (!security.verify(security.bearer(req), need)) return security.unauthorized(res, need);
    if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
    const identity = security.identity(security.bearer(req));
    const allowedApps = identity?.app_ids ?? null;
    const generic = new Set(["connector_identity","apps_list","server_status","task_submit","task_get","task_cancel"]);
    const canUseApp = id => allowedApps === null || allowedApps.includes(id);
    const canReadJob = job => job && canUseApp(job.app_id)
      && (!identity?.connector_id || !job.connector_id || job.connector_id === identity.connector_id);
    let result;
    try {
      if (rpc.method === "initialize") {
        result = { protocolVersion: ["2026-07-28", "2025-11-25", "2025-06-18"].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "CHK Universal Control", version: SERVER_VERSION } };
      } else if (rpc.method === "ping") result = {};
      else if (rpc.method === "tools/list") result = { tools: exposedTools().filter(tool => allowedApps === null || generic.has(tool.name)) };
      else if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        const a = rpc.params?.arguments || {};
        if (allowedApps !== null && !generic.has(name)) throw Error("connector_tool_not_allowed");
        const actor = identity?.connector_id ? "mcp:" + identity.connector_id : "mcp";
        const context = { source: actor, connector_id: identity?.connector_id || null };
        let output;
        const browserApp = () => store.listApps(false)
          .filter(v => v.name === "CHK Agent Browser Android · Local 3")
          .sort((a,b) => Number(b.online) - Number(a.online) || Number(b.registered_at) - Number(a.registered_at))[0];
        const cryptoApp = () => store.listApps(false)
          .filter(v => v.name === "CHK Crypto Analyse 2"
            && v.capabilities?.some(c => c.name === "ui_status"))
          .sort((a,b) => Number(b.online) - Number(a.online)
            || Number(b.registered_at) - Number(a.registered_at))[0];
        if (name === "connector_identity") output = identity;
        else if (name === "godot_status") output = await godot.status();
        else if (name === "godot_run" || name === "godot_batch") {
          if (name === "godot_run" && (typeof a.method !== "string" || a.method.length < 3 || a.method.length > 120)) throw Error("godot_invalid_method");
          if (name === "godot_batch" && (!Array.isArray(a.commands) || a.commands.length < 1 || a.commands.length > 12)) throw Error("godot_invalid_batch");
          const { request_id, ...args } = a;
          output = await store.submit({ app_id: "godot-local", action: name, args, source: actor, connector_id: identity?.connector_id, request_id });
        }
        else if (name === "crypto_capture" || name === "crypto_inspect" || name === "crypto_action") {
          const app = cryptoApp();
          if (!app) output = { error: "crypto_visual_capabilities_not_registered" };
          else {
            const action = name === "crypto_capture" ? "ui_capture"
              : name === "crypto_inspect" ? "ui_inspect" : a.action;
            if (!app.capabilities.some(c => c.name === action)) output = { error: "capability_not_registered" };
            else output = await store.submit({ app_id: app.id, action, args: name === "crypto_action" ? (a.args || {}) : {},
              request_id: a.request_id || "", ...context });
          }
        }
        else if (name === "crypto_result") {
          const job = store.getJob(a.task_id);
          output = canReadJob(job) ? job : { error: "task_not_found" };
        }
        else if (name === "server_status") output = { service: "CHK Universal Control", status: "running", apps: allowedApps === null ? Object.keys(store.state.apps).length + Number(Boolean(config.legacyUrl)) : allowedApps.length,
          connectors: Object.keys(store.state.connectors).length, oauth_clients: Object.keys(store.state.clients).length, registry_limit: null, ai_configured: Boolean(config.ollamaUrl), legacy_configured: Boolean(config.legacyUrl), version: SERVER_VERSION, browser_protocol: 2, browser_connected: Boolean(browserApp()?.online) };
        else if (name === "apps_list") output = store.appsPage(a, allowedApps, Boolean(config.legacyUrl));
        else if (name === "crypto_ticker") output = await markets.ticker(a);
        else if (name === "crypto_orderbook") output = await markets.orderbook(a);
        else if (name === "crypto_candles") output = await markets.candles(a);
        else if (name === "crypto_indicators") output = await markets.indicators(a);
        else if (name === "crypto_multi_timeframe") output = await markets.multi(a);
        else if (name === "crypto_instrument_rules") output = await markets.rules(a);
        else if (name === "crypto_market_movers") output = await markets.movers(a);
        else if (name === "crypto_web_read") output = await markets.webRead(a);
        else if (name === "crypto_status") output = crypto.status();
        else if (name === "crypto_scan_bybit") output = await crypto.scan(a);
        else if (name === "crypto_list_bybit") output = await crypto.page(a);
        else if (name === "crypto_portfolio") output = await crypto.dispatch("crypto_portfolio", {}, context);
        else if (name === "crypto_tracking") output = await crypto.dispatch("crypto_tracking", {}, context);
        else if (name === "crypto_task_result") output = canReadJob(store.getJob(a.task_id)) ? crypto.result(a) : { error: "crypto_task_not_found" };
        else if (name === "crypto_alerts") output = await crypto.dispatch("crypto_alerts", {}, context);
        else if (name === "crypto_bot_status") output = await crypto.dispatch("crypto_bot_status", {}, context);
        else if (name === "crypto_app_status") output = await crypto.dispatch("crypto_app_status", {}, context);
        else if (name === "crypto_chart_state") output = await crypto.dispatch("crypto_chart_state", {}, context);
        else if (name === "crypto_device_status") output = await crypto.dispatch("crypto_device_status", {}, context);
        else if (name === "crypto_chart_control") output = await crypto.chartControl(a, context);
        else if (name === "crypto_market_chart") output = await advancedMarket.chart(a);
        else if (name === "crypto_recent_trades") output = await advancedMarket.trades(a);
        else if (name === "crypto_internet_news") output = await advancedMarket.news(a);
        else if (name === "crypto_radar") output = await monitor.radar(a);
        else if (name === "crypto_monitor_status") output = monitor.status();
        else if (name === "crypto_monitor_config") output = await monitor.config(a);
        else if (name === "crypto_monitor_run") output = await monitor.run();
        else if (name === "crypto_monitor_events") output = monitor.events(a);
        else if (name === "app_register") output = await store.registerApp(a);
        else if (name === "app_invite") output = await store.createInvite();
        else if (name === "task_submit") {
          const app_id = a.app_id || (allowedApps?.length === 1 ? allowedApps[0] : null);
          if (!app_id) throw Error("app_id_required_choose_from_apps_list");
          if (!canUseApp(app_id)) throw Error("connector_app_not_allowed");
          output = await store.submit({ ...a, app_id, source: actor, connector_id: identity?.connector_id, legacy: Boolean(config.legacyUrl) });
        }
        else if (name === "task_get") {
          const job = store.getJob(a.task_id);
          output = canReadJob(job) ? job : { error: "task_not_found" };
        }
        else if (name === "task_cancel") {
          if (!canReadJob(store.getJob(a.task_id))) throw Error("task_not_found");
          output = await store.cancel(a.task_id);
        }
        else if (name === "ai_chat") output = await ai.chat(a.message, context);
        else if (name === "chk_read") output = !["server_info", "android_status"].includes(a.name || "android_status") ? { error: "forbidden_read_tool" } : config.legacyUrl ? await legacyCall(a.name || "android_status", {}) : browserApp() ? { connection: "paired_worker", app: browserApp(), legacy_required: false } : { error: "browser_not_paired", legacy_required: false };
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
        } else result = name === "task_get" ? browserResult(output, store) : textResult(output);
      } else return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
      return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
    } catch (err) {
      return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: textResult({ error: err.message || "internal_error" }) });
    }
  };
}
