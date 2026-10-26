// CHK Crypto market supervisor: user-opt-in, local PC, no automatic trading.
// This monitor only stores public market observations; it neither buys nor sells.
export const monitorTools=[
 {name:"crypto_radar",title:"Radar complet Bybit EU Spot",description:"Analyse toutes les paires Spot disponibles, classe hausses/baisses, liquidité et spreads approximatifs, sans ordre ni garantie de gain.",inputSchema:{type:"object",properties:{quote:{type:"string",enum:["ALL","USDC"]},limit:{type:"integer",minimum:1,maximum:50}}},readOnlyHint:true},
 {name:"crypto_monitor_status",title:"État supervision crypto PC",description:"Rapporte l'état réel du superviseur local, la fréquence, la dernière vérification, les actifs suivis et les incidents.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
 {name:"crypto_monitor_config",title:"Configurer la surveillance crypto",description:"Active ou arrête une surveillance locale des prix publics sur une liste d'actifs, toutes les 5-60 minutes. Aucune exécution de trade. Nécessite le scope d'écriture.",inputSchema:{type:"object",required:["enabled"],properties:{enabled:{type:"boolean"},symbols:{type:"array",minItems:0,maxItems:20,items:{type:"string"}},interval_minutes:{type:"integer",minimum:5,maximum:60},alert_change_pct:{type:"number",minimum:0.5,maximum:25}}}},
 {name:"crypto_monitor_run",title:"Actualiser surveillance crypto",description:"Déclenche un contrôle ponctuel des seuils de surveillance publique, sans trading.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
 {name:"crypto_monitor_events",title:"Événements de surveillance crypto",description:"Retourne les événements publics de prix déclenchés par les seuils; aucune notification externe automatique.",inputSchema:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:100}}},readOnlyHint:true}
];
const safe=(s)=>typeof s==="string"&&/^[A-Z0-9]{4,32}$/.test(s);
export function createCryptoMonitor(store,crypto,{clock=Date.now}={}){
  let working=false;
  const record=()=>store.state.crypto_monitor||{enabled:false,symbols:[],interval_minutes:15,alert_change_pct:4,last_run:0,last_error:null,events:[],last_values:{}};
  function status(){const r=record();return {enabled:r.enabled,symbols:r.symbols,interval_minutes:r.interval_minutes,alert_change_pct:r.alert_change_pct,last_run:r.last_run,last_error:r.last_error,event_count:r.events.length,working,hosting:"local PC",trading:false,push_notification:false,warning:"Works only while PC server is active; operating system/network can interrupt."};}
  async function config(args){
    if(typeof args.enabled!=="boolean")throw Error("invalid_enabled");
    const symbols=(args.symbols||record().symbols).map(x=>String(x).toUpperCase());
    if(!Array.isArray(symbols)||symbols.length>20||symbols.some(s=>!safe(s)))throw Error("invalid_symbols");
    const minutes=Number(args.interval_minutes??record().interval_minutes);
    const threshold=Number(args.alert_change_pct??record().alert_change_pct);
    if(!Number.isInteger(minutes)||minutes<5||minutes>60||!Number.isFinite(threshold)||threshold<0.5||threshold>25)throw Error("invalid_monitor_config");
    await store.change(s=>{
      const prev=record();
      s.crypto_monitor={...prev,enabled:args.enabled,symbols:[...new Set(symbols)],interval_minutes:minutes,alert_change_pct:threshold};
    });
    return status();
  }
  async function allMarkets(){
    const result=[];
    for(let offset=0;offset<15000;offset+=100){
      const page=await crypto.page({offset,limit:100});
      result.push(...page.items);
      if(page.next_offset===null)break;
    }
    return result;
  }
  async function radar(args={}){
    const list=await allMarkets();
    const quote=String(args.quote||"USDC"),limit=Math.max(1,Math.min(50,Number(args.limit)||20));
    if(!["ALL","USDC"].includes(quote))throw Error("invalid_quote");
    const filtered=list.filter(i=>(quote==="ALL"||i.quoteCoin===quote)&&i.lastPrice&&Number(i.turnover24h)>=0);
    const byVolume=[...filtered].sort((a,b)=>b.turnover24h-a.turnover24h).slice(0,limit);
    const byGainer=[...filtered].sort((a,b)=>b.change24hPct-a.change24hPct).slice(0,limit);
    const byLoser=[...filtered].sort((a,b)=>a.change24hPct-b.change24hPct).slice(0,limit);
    return {source:"Bybit EU public Spot",full_universe_scanned:true,total_scanned:list.length,
      matching:filtered.length,filter:quote,top_by_turnover:byVolume,top_gainers:byGainer,
      top_losers:byLoser,checked_at:new Date(clock()).toISOString(),trades_executed:0,
      warning:"Price spikes can be illiquid or reverse; rankings are not automatic trading signals."};
  }
  async function run(){
    if(working)return {state:"already_running",...status()};
    const prev=record();
    if(!prev.enabled||prev.symbols.length===0)return {state:"disabled_or_no_assets",...status()};
    if(clock()-prev.last_run<prev.interval_minutes*60000-20000)return {state:"not_due",...status()};
    working=true;
    try {
      const rows=await allMarkets();
      const bySymbol=new Map(rows.map(x=>[x.symbol,x]));
      const events=[],lastValues={...prev.last_values};
      for(const symbol of prev.symbols){
        const row=bySymbol.get(symbol),current=Number(row?.lastPrice);
        if(!Number.isFinite(current)||current<=0)continue;
        const old=Number(lastValues[symbol]||0);
        if(old>0){
          const pct=(current-old)/old*100;
          if(Math.abs(pct)>=prev.alert_change_pct)events.push({
            symbol,previous:old,current,change_pct:Number(pct.toFixed(3)),
            at:clock(),observation_only:true
          });
        }
        lastValues[symbol]=current;
      }
      await store.change(s=>{
        const latest=record();
        s.crypto_monitor={...latest,last_run:clock(),last_error:null,last_values:lastValues,
          events:[...events,...(latest.events||[])].slice(0,100)};
      });
      return {state:"completed",new_events:events.length,...status()};
    }catch(e){
      await store.change(s=>{s.crypto_monitor={...record(),last_run:clock(),last_error:String(e.message||e).slice(0,120)};});
      return {state:"failed",...status()};
    } finally{working=false;}
  }
  function events(args={}){
    const limit=Math.max(1,Math.min(100,Number(args.limit)||20));
    return {source:"local PC public-market observation",events:record().events.slice(0,limit),generated_trades:0};
  }
  // Lightweight timer is not a promise of 24/7 availability and does not
  // prevent shutdown. No loop starts until the user enables monitoring.
  const timer=setInterval(()=>{if(record().enabled&&!working)void run();},60000);
  timer.unref?.();
  return {radar,status,config,run,events};
}
