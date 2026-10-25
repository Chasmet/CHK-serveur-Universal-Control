// CHK Crypto independent MCP module. Public Bybit EU Spot market scan,
// explicitly authorized Android read-only agent. No order execution.
const ENDPOINT = "https://api.bybit.eu";
const CACHE_MS = 120_000;
const MAX_ITEMS = 100;
export const cryptoTools = [
  {name:"crypto_status",title:"CHK Crypto — connexion",description:"Statut du module CHK Crypto Android et de la dernière analyse publique Bybit EU. Aucune clé privée.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_scan_bybit",title:"Scanner TOUT Bybit EU Spot",description:"Interroge le catalogue COMPLET des instruments Spot Bybit EU (pagination Spot non supportée) et les tickers publics. Aucun ordre. Renvoie le total des cryptos et paires scannées, les marchés CRYPTO/USDC et les principaux volumes. Résultats réels uniquement; cache 2 min.",inputSchema:{type:"object",properties:{force:{type:"boolean",description:"Recharger le marché, dans la limite anti-surcharge."}}},readOnlyHint:true},
  {name:"crypto_list_bybit",title:"Liste complète des cryptos Bybit",description:"Parcourt par pages les symboles issus du dernier scan COMPLET Bybit EU Spot; quote ALL ou USDC, offset, limit jusqu'à 100.",inputSchema:{type:"object",properties:{quote:{type:"string",enum:["ALL","USDC"]},offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:100}}},readOnlyHint:true},
  {name:"crypto_portfolio",title:"CHK Crypto — portefeuille Android",description:"Demande en lecture seule un instantané des positions Binance et Bybit stockées dans CHK Crypto Android. Peut retourner queued lorsque le téléphone n'est pas connecté. Jamais de clés API.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_tracking",title:"CHK Crypto — surveillance Android",description:"Demande en lecture seule l'état du suivi et de la connexion marché depuis CHK Crypto Android. Aucun ordre.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_task_result",title:"CHK Crypto — résultat",description:"Récupère l'état réel d'une requête CHK Crypto. queued/leased n'est jamais completed.",inputSchema:{type:"object",required:["task_id"],properties:{task_id:{type:"string"}}},readOnlyHint:true}
];
export function createCryptoModule(store,{base=ENDPOINT,fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(base!==ENDPOINT) throw Error("bybit_eu_only");
  let cache=null;
  let scanInFlight=null;
  let lastFetch=0;
  const name="CHK Crypto Android";
  function agent(){return Object.values(store.state.apps).find(a=>a.name===name && !a.system && a.secret_hash);}
  function status(){
    const a=agent(), age=a?.last_seen?now()-a.last_seen:null;
    return {module:"CHK Crypto",app_id:a?.id||null,registered:Boolean(a),android_online:age!==null&&age<90000,
      last_seen:a?.last_seen||null,market_scan_at:cache?.time||null,scanned_spot_symbols:cache?.items.length||0,
      endpoint:ENDPOINT,read_only:true,real_orders:"not supported through universal crypto MCP"};
  }
  async function api(path){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),14000);
    try{
      const resp=await fetchImpl(ENDPOINT+path,{method:"GET",signal:controller.signal,redirect:"error",headers:{Accept:"application/json","User-Agent":"CHK-Crypto-Universal/1.0"}});
      if(!resp.ok)throw Error("bybit_http_"+resp.status);
      const data=await resp.json();
      if(data?.retCode!==0)throw Error("bybit_retcode_"+String(data?.retCode));
      return data?.result||{};
    } finally {clearTimeout(timer);}
  }
  async function load(force=false){
    if(cache&&now()-cache.time<CACHE_MS)return cache;
    if(scanInFlight)return scanInFlight;
    if(lastFetch&&now()-lastFetch<10000)throw Error("bybit_scan_rate_limited");
    lastFetch=now();
    scanInFlight=(async()=>{
      // Bybit explicitly disallows cursor/limit for Spot. One request
      // returns ALL trading Spot instruments; do not truncate at 500.
      const instruments=await api("/v5/market/instruments-info?category=spot");
      const list=instruments.list;
      if(!Array.isArray(list))throw Error("bybit_instruments_missing");
      const tickers=await api("/v5/market/tickers?category=spot");
      const prices=new Map((tickers.list||[]).map(t=>[t.symbol,t]));
      const items=list.filter(x=>typeof x.symbol==="string"&&x.status==="Trading")
        .map(x=>({symbol:x.symbol,baseCoin:x.baseCoin||"",quoteCoin:x.quoteCoin||"",
          status:x.status,
          lastPrice:prices.get(x.symbol)?.lastPrice||"",
          change24hPct:Number(prices.get(x.symbol)?.price24hPcnt||0)*100,
          turnover24h:Number(prices.get(x.symbol)?.turnover24h||0)}))
        .sort((a,b)=>a.symbol.localeCompare(b.symbol));
      if(!items.length)throw Error("bybit_empty_spot_catalogue");
      cache={time:now(),items,rawCount:list.length};
      return cache;
    })().finally(()=>{scanInFlight=null;});
    return scanInFlight;
  }
  async function scan(args={}){
    const c=await load(args.force===true);
    const usdc=c.items.filter(x=>x.quoteCoin==="USDC");
    return {source:"Bybit EU API V5",scan_complete:true,category:"spot",sampled:false,
      scanned_at:new Date(c.time).toISOString(),total_spot_pairs:c.items.length,
      unique_spot_cryptos:new Set(c.items.map(x=>x.baseCoin)).size,
      usdc_pairs:usdc.length,
      usdc_top_turnover:usdc.slice().sort((a,b)=>b.turnover24h-a.turnover24h).slice(0,20),
      note:"Toutes les paires Spot échangées sont examinées; aucun Futures ni levier. Pagination via crypto_list_bybit. Analyse descriptive, pas signal d'achat."};
  }
  async function page(args={}){
    const c=await load();
    const quote=args.quote||"ALL";
    if(!["ALL","USDC"].includes(quote))throw Error("invalid_quote");
    const offset=Number(args.offset??0),limit=Number(args.limit??50);
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>MAX_ITEMS)throw Error("invalid_pagination");
    const list=quote==="USDC"?c.items.filter(i=>i.quoteCoin==="USDC"):c.items;
    return {source:ENDPOINT,scan_complete:true,quote,offset,limit,total:list.length,
      scanned_at:new Date(c.time).toISOString(),items:list.slice(offset,offset+limit),
      next_offset:offset+limit<list.length?offset+limit:null};
  }
  async function dispatch(action) {
    const app=agent();
    if(!app)return {error:"crypto_android_not_registered",hint:"Ouvrir CHK Crypto > Connexion serveur universel puis saisir une invitation MCP."};
    if(!app.capabilities.some(c=>c.name===action&&c.readOnly===true))return {error:"crypto_read_capability_missing"};
    const task=await store.submit({app_id:app.id,action,args:{},source:"crypto-mcp"});
    return {task_id:task.id,state:task.state,android_online:Boolean(app.last_seen&&now()-app.last_seen<90000),
      hint:"La réponse n'est disponible qu'après l'exécution sur Android. Utiliser crypto_task_result."};
  }
  function result(args){
    const app=agent();
    const job=store.getJob(args?.task_id);
    if(!app||!job||job.app_id!==app.id||!["crypto_portfolio","crypto_tracking"].includes(job.action))return {error:"crypto_task_not_found"};
    return {task_id:job.id,state:job.state,result:job.state==="completed"?job.result:null,
      completed:job.state==="completed",hint:job.state==="queued"?"Ouvrir ou connecter CHK Crypto Android.":null};
  }
  return {status,scan,page,dispatch,result};
}
