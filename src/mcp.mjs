import { cryptoTools } from "./crypto.mjs";
import { cryptoDeviceTools } from "./crypto-device-tools.mjs";
import { asReadOnly as cryptoMarketTools } from "./crypto-markets.mjs";
import { marketTools as advancedMarketTools } from "./crypto-market.mjs";
import { monitorTools } from "./crypto-monitor.mjs";

const tools = [
  { name: "godot_status", title: "Pirate Warrior 2 - état", description: "Vérifie la connexion à l’éditeur Godot réel sur le PC, sans prétendre qu’une tâche est terminée.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "godot_run", title: "Pirate Warrior 2 - commande", description: "Prépare une commande Godot, à approuver dans le panneau local avant son exécution réelle.", inputSchema: { type: "object", required: ["method"], properties: { method: { type: "string" }, params: { type: "object" }, request_id: { type: "string" } } } },
  { name: "godot_batch", title: "Pirate Warrior 2 - commandes groupées", description: "Prépare 1 à 12 commandes Godot, à approuver avant exécution.", inputSchema: { type: "object", required: ["commands"], properties: { commands: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", required: ["method"], properties: { method: { type: "string" }, params: { type: "object" } } } }, request_id: { type: "string" } } } },
  { name: "server_status", title: "Etat CHK Universal", description: "Informations non sensibles sur le serveur et le moteur IA.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "apps_list", title: "Applications connectees", description: "Lister les applications enregistrées et les capacités exposées.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "app_register", title: "Enregistrer application", description: "Enregistre une application avec capacités déclarées. Retourne une clé privée UNE SEULE FOIS; ne la publiez jamais.", inputSchema: { type: "object", required: ["name", "capabilities"], properties: { name: { type: "string" }, capabilities: { type: "array", items: { type: "object", required: ["name", "readOnly"], properties: { name: { type: "string" }, description: { type: "string" }, readOnly: { type: "boolean" } } } } } } },
  { name: "app_invite", title: "Invitation application", description: "Génère une invitation unique de 15 minutes pour qu’une nouvelle application s’enregistre sans donner le mot de passe principal.", inputSchema: { type: "object", properties: {} } },
  { name: "task_submit", title: "Envoyer une commande", description: "Envoie une action vers une application enregistrée. Les actions d'écriture requièrent approbation explicite; l'état queued n'est pas completed.", inputSchema: { type: "object", required: ["app_id", "action"], properties: { app_id: { type: "string" }, action: { type: "string" }, args: { type: "object" }, request_id: { type: "string" } } } },
  { name: "task_get", title: "Etat de tâche", description: "Lire le résultat réel ou l'état d'une tâche.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } }, readOnlyHint: true },
  { name: "task_cancel", title: "Annuler commande", description: "Annule une tâche encore non exécutée.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } } },
  { name: "ai_chat", title: "Assistant Qwen open source", description: "Pose une question au modèle local via Ollama et orchestre des outils disponibles. Modèle externe optionnel.", inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } } } },
  { name: "chk_read", title: "CHK existant: lecture", description: "Interroge uniquement server_info ou android_status de la passerelle MCP CHK existante, si configurée.", inputSchema: { type: "object", properties: { name: { type: "string", enum: ["server_info", "android_status"] } } }, readOnlyHint: true }
];
const textResult = obj => ({ content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj, isError: Boolean(obj?.error) });
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
  const writeTools = new Set(["app_register", "app_invite", "task_submit", "task_cancel", "ai_chat", "godot_run", "godot_batch", "crypto_chart_control", "crypto_monitor_config"]);
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
        if (name === "godot_status") output = await godot.status();
        else if (name === "godot_run" || name === "godot_batch") {
          if (name === "godot_run" && (typeof a.method !== "string" || a.method.length < 3 || a.method.length > 120)) throw Error("godot_invalid_method");
          if (name === "godot_batch" && (!Array.isArray(a.commands) || a.commands.length < 1 || a.commands.length > 12)) throw Error("godot_invalid_batch");
          const { request_id, ...args } = a;
          output = await store.submit({ app_id: "godot-local", action: name, args, source: "mcp", request_id });
        }
        else if (name === "server_status") output = { service: "CHK Universal Control", status: "running", apps: store.listApps(Boolean(config.legacyUrl)).length, ai_configured: Boolean(config.ollamaUrl), legacy_configured: Boolean(config.legacyUrl) };
        else if (name === "apps_list") output = { apps: store.listApps(Boolean(config.legacyUrl)) };
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
        else if (name === "crypto_portfolio") output = await crypto.dispatch("crypto_portfolio");
        else if (name === "crypto_tracking") output = await crypto.dispatch("crypto_tracking");
        else if (name === "crypto_task_result") output = crypto.result(a);
        else if (name === "crypto_alerts") output = await crypto.dispatch("crypto_alerts");
        else if (name === "crypto_bot_status") output = await crypto.dispatch("crypto_bot_status");
        else if (name === "crypto_app_status") output = await crypto.dispatch("crypto_app_status");
        else if (name === "crypto_chart_state") output = await crypto.dispatch("crypto_chart_state");
        else if (name === "crypto_device_status") output = await crypto.dispatch("crypto_device_status");
        else if (name === "crypto_chart_control") output = await crypto.chartControl(a);
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
        else if (name === "task_submit") output = await store.submit({ ...a, source: "mcp", legacy: Boolean(config.legacyUrl) });
        else if (name === "task_get") output = store.getJob(a.task_id) || { error: "task_not_found" };
        else if (name === "task_cancel") output = await store.cancel(a.task_id);
        else if (name === "ai_chat") output = await ai.chat(a.message);
        else if (name === "chk_read") output = !["server_info", "android_status"].includes(a.name || "android_status") ? { error: "forbidden_read_tool" } : config.legacyUrl ? await legacyCall(a.name || "android_status", {}) : { error: "legacy_not_configured" };
        else return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown tool" } });
        result = textResult(output);
      } else return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
      return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
    } catch (err) {
      return security.json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: textResult({ error: err.message || "internal_error" }) });
    }
  };
}
