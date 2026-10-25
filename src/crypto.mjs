/**
 * CHK Crypto Analyse 2: isolated, read-only extension of the ONE universal MCP.
 * Public spot-market data comes from Bybit EU; private portfolio/tracking
 * snapshots are delivered only by an explicitly paired Android worker.
 * Neither this module nor its tools can place, cancel or replace orders.
 */
const BASE = "https://api.bybit.eu";
const CACHE_MS = 60_000;
const NAME = "CHK Crypto Analyse 2";
const READ_CAPABILITIES = new Set(["portfolio_snapshot", "tracking_status", "app_diagnostics", "market_watch_status", "bot_rules_summary"]);

export const cryptoToolDefinitions = [
  { name: "crypto_chart_analysis", title: "CHK Crypto - analyse graphique", description: "Analyse les 200 dernières bougies Spot Bybit EU d’une paire et d’une unité de temps: RSI 14, EMA 20/50, MACD, bandes de Bollinger, ATR, supports/résistances. Aucune exécution d’ordre.", inputSchema: {type:"object",required:["symbol"],properties:{symbol:{type:"string"},timeframe:{type:"string",description:"1, 5, 15, 60, 240, D, W..."}}},readOnlyHint:true },
  { name: "crypto_multi_timeframes", title: "CHK Crypto - analyse multi-unités", description: "Analyse indépendante d'une paire sur 1 à 6 unités de temps Bybit Spot. Convergence indicative des indicateurs, sans ordres.", inputSchema:{type:"object",required:["symbol"],properties:{symbol:{type:"string"},timeframes:{type:"array",items:{type:"string"},maxItems:6}}},readOnlyHint:true },
  { name: "crypto_news_search", title: "CHK Crypto - recherche actualités", description: "Recherche des nouvelles publiques sur Internet via un moteur d'actualités. Toujours recouper les informations externes.",inputSchema:{type:"object",properties:{query:{type:"string"},limit:{type:"integer",minimum:1,maximum:15}}},readOnlyHint:true },
  { name: "crypto_public_page", title: "CHK Crypto - consulter site public", description: "Ouvre en lecture seule un article public d'un domaine financier autorisé; interdit toute URL locale, privée ou arbitraire.",inputSchema:{type:"object",required:["url"],properties:{url:{type:"string"}}},readOnlyHint:true },
  { name: "crypto_app_diagnostics", title: "CHK Crypto - diagnostic Android", description: "Demande le diagnostic réseau et la version de CHK Crypto Android, lecture seule. Utiliser task_get.",inputSchema:{type:"object",properties:{request_id:{type:"string"}}},readOnlyHint:true },
  { name: "crypto_market_watch_status", title: "CHK Crypto - suivi marchés Android", description: "Vérifie si le suivi en tâche de fond du téléphone est activé et connecté, sans modifier les règles. Utiliser task_get.",inputSchema:{type:"object",properties:{request_id:{type:"string"}}},readOnlyHint:true },
  { name: "crypto_bot_rules_summary", title: "CHK Crypto - règles Bot", description: "Résumé en lecture seule des règles locales de surveillance de CHK Crypto, sans commandes de trading. Utiliser task_get.",inputSchema:{type:"object",properties:{request_id:{type:"string"}}},readOnlyHint:true },
  { name: "crypto_status", title: "CHK Crypto Analyse 2 - connexion", description: "Vérifie si l'application CHK Crypto Android est appairée et a récemment contacté le serveur universel.", inputSchema: { type: "object", properties: {} }, readOnlyHint: true },
  { name: "crypto_scan_bybit", title: "CHK Crypto - scan complet Bybit Spot", description: "Scanne TOUT le catalogue public Bybit EU Spot (toutes les cryptos/paires disponibles), et tous les tickers. Filtre et classe éventuellement les résultats ; n'envoie aucun ordre. Les ordres réels restent dans CHK Crypto Android avec confirmation utilisateur.", inputSchema: { type: "object", properties: {
    quote: { type: "string", enum: ["ALL", "USDC", "USDT"], description: "Filtre de devise après scan global, défaut ALL" },
    minTurnoverUsd: { type: "number", minimum: 0, description: "Volume négocié 24h minimum approximatif en USD" },
    limit: { type: "integer", minimum: 1, maximum: 80, description: "Nombre de paires renvoyées au maximum, défaut 35" }
  } }, readOnlyHint: true },
  { name: "crypto_portfolio_snapshot", title: "CHK Crypto - portefeuille Android", description: "Demande à CHK Crypto une lecture des DERNIÈRES données Binance/Bybit enregistrées sur le téléphone. Les clés API restent sur Android. Résultat asynchrone : consulter task_get avec l'identifiant renvoyé. Aucune opération de trading.", inputSchema: { type: "object", properties: { request_id: { type: "string" } } }, readOnlyHint: true },
  { name: "crypto_tracking_status", title: "CHK Crypto - état tracking Android", description: "Demande l'état local du suivi Binance/Bybit dans CHK Crypto. Résultat asynchrone : utiliser task_get.", inputSchema: { type: "object", properties: { request_id: { type: "string" } } }, readOnlyHint: true }
];

function fixedNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}
const quotes = new Set(["ALL", "USDC", "USDT"]);
function filteredArgs(input = {}) {
  const quote = String(input.quote || "ALL").toUpperCase();
  if (!quotes.has(quote)) throw Error("crypto_invalid_quote");
  const limit = Number(input.limit ?? 35);
  const minTurnoverUsd = Number(input.minTurnoverUsd ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 80) throw Error("crypto_invalid_limit");
  if (!Number.isFinite(minTurnoverUsd) || minTurnoverUsd < 0) throw Error("crypto_invalid_turnover");
  return {quote, limit, minTurnoverUsd};
}
export function createCryptoModule({store, fetchImpl = fetch, now = Date.now, cacheMs = CACHE_MS, intelligence} = {}) {
  let cache = null;
  let loading = null;
  function androidApp() {
    const matches = store.listApps(false).filter(a =>
      a.name === NAME && a.connection === "worker" &&
      a.capabilities.some(c => READ_CAPABILITIES.has(c.name)));
    return matches.sort((a,b) => Number(Boolean(b.online)) - Number(Boolean(a.online)) ||
      b.registered_at - a.registered_at)[0] || null;
  }
  async function fetchJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetchImpl(BASE + path, {
        method: "GET", headers: {accept: "application/json", "user-agent": "CHK-Universal-Crypto-ReadOnly/1.0"},
        signal: controller.signal, redirect: "error"
      });
      if (!response.ok) throw Error("crypto_bybit_http_" + response.status);
      const body = await response.json();
      if (Number(body.retCode) !== 0) throw Error("crypto_bybit_api_" + String(body.retCode));
      return body.result;
    } finally {clearTimeout(timer);}
  }
  async function refresh() {
    const [instruments, tickers] = await Promise.all([
      fetchJson("/v5/market/instruments-info?category=spot"),
      fetchJson("/v5/market/tickers?category=spot")
    ]);
    // Bybit's Spot endpoint is intentionally unpaginated (cursor is unsupported).
    // Refuse a partial catalogue instead of claiming an all-market scan.
    if (!Array.isArray(instruments?.list) || !instruments.list.length ||
        !Array.isArray(tickers?.list) || !tickers.list.length ||
        Boolean(instruments.nextPageCursor)) throw Error("crypto_bybit_incomplete_market_catalogue");
    const prices = new Map(tickers.list.map(t => [String(t.symbol || "").toUpperCase(), t]));
    const symbols = new Set();
    const items = [];
    const byQuote = {};
    for (const info of instruments.list) {
      const symbol = String(info.symbol || "").toUpperCase();
      const baseCoin = String(info.baseCoin || "").toUpperCase();
      const quoteCoin = String(info.quoteCoin || "").toUpperCase();
      if (!/^[A-Z0-9]{4,32}$/.test(symbol) || !baseCoin || !quoteCoin ||
          symbols.has(symbol) || String(info.status || "").toUpperCase() !== "TRADING") continue;
      symbols.add(symbol);
      byQuote[quoteCoin] = (byQuote[quoteCoin] || 0) + 1;
      const ticker = prices.get(symbol);
      items.push({
        symbol, baseCoin, quoteCoin,
        lastPrice: fixedNumber(ticker?.lastPrice),
        change24hPct: Number.isFinite(Number(ticker?.price24hPcnt)) ? Number(ticker.price24hPcnt) * 100 : null,
        turnover24hUsdApprox: fixedNumber(ticker?.turnover24h),
        volume24h: fixedNumber(ticker?.volume24h),
        marketDataAvailable: Boolean(ticker),
        minOrderAmt: String(info.lotSizeFilter?.minOrderAmt || "")
      });
    }
    if (!items.length) throw Error("crypto_bybit_no_trading_spot_markets");
    cache = {at:now(),items,byQuote,instrumentsCount:instruments.list.length,
      tickersCount:tickers.list.length,baseCount:new Set(items.map(x=>x.baseCoin)).size};
    return cache;
  }
  async function scan(input) {
    const args = filteredArgs(input);
    if (!cache || now() - cache.at > cacheMs) {
      if (!loading) loading = refresh().finally(() => {loading = null;});
      await loading;
    }
    const matching = cache.items.filter(x =>
      (args.quote === "ALL" || x.quoteCoin === args.quote) &&
      x.turnover24hUsdApprox >= args.minTurnoverUsd
    ).sort((a,b) => b.turnover24hUsdApprox - a.turnover24hUsdApprox || a.symbol.localeCompare(b.symbol));
    return {
      ok:true,source:BASE,category:"spot",readOnly:true,scannedAllAvailableSpot:true,
      retrievedAt:new Date(cache.at).toISOString(),cacheAgeMs:Math.max(0,now()-cache.at),
      instrumentsReturned:cache.instrumentsCount,tickersReturned:cache.tickersCount,
      tradingPairs:cache.items.length,uniqueBaseCoins:cache.baseCount,
      allQuotes:cache.byQuote,quoteFilter:args.quote,matchingPairs:matching.length,
      returnedPairs:Math.min(matching.length,args.limit),markets:matching.slice(0,args.limit),
      note:"Toutes les paires Spot disponibles ont été analysées avant filtrage. Les volumes en USD sont approximatifs selon la devise de cotation. Marchés disponibles sur Bybit EU uniquement, pas tous les tokens existants.",
      tradingPolicy:"ANALYSE_SEULEMENT; aucune création, modification ni annulation d'ordre"
    };
  }
  async function queue(action, input={}) {
    const app = androidApp();
    if (!app) return {ok:false,paired:false,error:"crypto_android_not_paired",
      instruction:"Dans CHK Crypto > Réglages > CHK Serveur Universel, appairer une fois avec le mot de passe administrateur du serveur PC."};
    const job = await store.submit({app_id:app.id,action,args:{},
      request_id:input.request_id ? String(input.request_id).slice(0,100) : "",
      source:"mcp"});
    return {ok:true,paired:true,online:app.online,task_id:job.id,state:job.state,
      resultPending:true,nextTool:"task_get",nextArguments:{task_id:job.id},
      note:"Données privées lues et transmises uniquement par CHK Crypto Android, pas depuis le serveur."};
  }
  return {
    async run(name,args={}) {
      if (name==="crypto_status") {
        const app = androidApp();
        return {ok:true,server:"CHK Universal Control",module:NAME,
          paired:Boolean(app),androidOnline:Boolean(app?.online),
          lastSeen:app?.last_seen || null,
          publicMarketScanAvailable:true,
          localAgentActions:[...READ_CAPABILITIES],
          execution:"READ_ONLY",realOrders:"NOT_AVAILABLE_IN_THIS_MODULE"};
      }
      if (name==="crypto_scan_bybit") return scan(args);
      if (name==="crypto_chart_analysis") return intelligence.chart(args);
      if (name==="crypto_multi_timeframes") return intelligence.multi(args);
      if (name==="crypto_news_search") return intelligence.news(args);
      if (name==="crypto_public_page") return intelligence.openPublicPage(args);
      if (name==="crypto_app_diagnostics") return queue("app_diagnostics",args);
      if (name==="crypto_market_watch_status") return queue("market_watch_status",args);
      if (name==="crypto_bot_rules_summary") return queue("bot_rules_summary",args);
      if (name==="crypto_portfolio_snapshot") return queue("portfolio_snapshot",args);
      if (name==="crypto_tracking_status") return queue("tracking_status",args);
      throw Error("crypto_unknown_tool");
    }
  };
}
