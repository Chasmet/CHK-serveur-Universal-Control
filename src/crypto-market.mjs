/**
 * CHK Crypto Analyse 2 — public internet market research and technical analysis.
 * Never accepts arbitrary URLs, credentials, order execution, or a server proxy.
 * Spot-only Bybit EU data. Independent from Godot and private app pairing.
 */
const BASE = "https://api.bybit.eu";
const NEWS = Object.freeze({
  coindesk: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  cointelegraph: "https://cointelegraph.com/rss"
});
const INTERVALS = new Set(["1","3","5","15","30","60","120","240","360","720","D","W"]);
const SYMBOL = /^[A-Z0-9]{4,32}$/;
const safeNumber = value => { const n=Number(value); return Number.isFinite(n)?n:0; };
const cap = (value,min,max,defaultValue)=>Number.isInteger(Number(value))?Math.max(min,Math.min(max,Number(value))):defaultValue;
const round = n => n==null||!Number.isFinite(n)?null:Number(n.toPrecision(9));
const last = v => v[v.length-1];
function ema(points, n) {
  if(points.length<n)return null;
  let val=points.slice(0,n).reduce((a,b)=>a+b,0)/n;
  const k=2/(n+1);
  for(let i=n;i<points.length;i++) val=points[i]*k+val*(1-k);
  return val;
}
function rsi(points,n=14) {
  if(points.length<=n)return null;
  let gain=0,loss=0;
  for(let i=1;i<=n;i++){const d=points[i]-points[i-1];gain+=Math.max(d,0);loss+=Math.max(-d,0);}
  gain/=n;loss/=n;
  for(let i=n+1;i<points.length;i++){const d=points[i]-points[i-1];gain=(gain*(n-1)+Math.max(d,0))/n;loss=(loss*(n-1)+Math.max(-d,0))/n;}
  return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
}
const sma=(points,n)=>points.length<n?null:points.slice(-n).reduce((a,b)=>a+b,0)/n;
function macd(points) {
  if(points.length<35)return {macd:null,signal:null,histogram:null};
  // Full EMA series and a true 9-period signal EMA, not EMA of a single value.
  const series=[];
  for(let i=26;i<=points.length;i++) {
    const e12=ema(points.slice(0,i),12),e26=ema(points.slice(0,i),26);
    series.push(e12-e26);
  }
  const value=last(series);
  const signal=ema(series,9);
  return {macd:round(value),signal:round(signal),histogram:signal==null?null:round(value-signal)};
}
function indicators(bars) {
  const p=bars.map(b=>b.close), highs=bars.map(b=>b.high),lows=bars.map(b=>b.low);
  const averages= {ema9:round(ema(p,9)),ema20:round(ema(p,20)),ema50:round(ema(p,50)),sma20:round(sma(p,20)),sma50:round(sma(p,50)),rsi14:round(rsi(p,14)),...macd(p)};
  let atr=null;
  if(bars.length>=15){let sum=0;for(let i=bars.length-14;i<bars.length;i++){const b=bars[i],prev=bars[i-1]?.close||b.open;sum+=Math.max(b.high-b.low,Math.abs(b.high-prev),Math.abs(b.low-prev));}atr=sum/14;}
  averages.atr14=round(atr);
  if(p.length>=20){const slice=p.slice(-20),mean=sma(p,20),variance=slice.reduce((a,b)=>a+(b-mean)**2,0)/20,dev=Math.sqrt(variance);averages.bollinger={lower:round(mean-2*dev),middle:round(mean),upper:round(mean+2*dev)};}
  else averages.bollinger=null;
  averages.support=round(Math.min(...lows.slice(-30)));
  averages.resistance=round(Math.max(...highs.slice(-30)));
  const recentVolume=bars.slice(-20).map(x=>x.volume),prevVolume=bars.slice(-40,-20).map(x=>x.volume);
  averages.volumeRatio=prevVolume.length?round((recentVolume.reduce((a,b)=>a+b,0)/recentVolume.length)/(prevVolume.reduce((a,b)=>a+b,0)/prevVolume.length||1)):null;
  return averages;
}
const unescapeXml=v=>v.replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&#39;","'").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").replace(/<[^>]*>/g,"").trim();
function headlines(xml,search,limit) {
  const out=[],needle=String(search||"").toLowerCase();
  for(const part of xml.match(/<item\b[\s\S]*?<\/item>/g)||[]) {
    const title=unescapeXml((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(part)||[])[1]||"").slice(0,220);
    const link=unescapeXml((/<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(part)||[])[1]||"").slice(0,350);
    const date=unescapeXml((/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i.exec(part)||[])[1]||"").slice(0,100);
    if(!title || (needle&&!title.toLowerCase().includes(needle)))continue;
    if(!/^https:\/\//.test(link))continue;
    out.push({title,link,published:date});
    if(out.length>=limit)break;
  }
  return out;
}
export const marketTools=[
 {name:"crypto_market_chart",title:"CHK Crypto graphique avancé",description:"Graphique Bybit EU Spot réel: bougies OHLCV, EMA 9/20/50, SMA, RSI14, MACD, ATR, Bollinger, volumes et supports/résistances. Aucune transaction.",inputSchema:{type:"object",required:["symbol"],properties:{symbol:{type:"string"},interval:{type:"string",enum:[...INTERVALS]},limit:{type:"integer",minimum:40,maximum:240}}},readOnlyHint:true},
 {name:"crypto_multi_timeframe",title:"CHK Crypto multi-timeframes",description:"Analyse 1m/5m/15m/1h/4h/1j/1w sur une paire Spot Bybit, RSI/EMA et tendance; aucune promesse de gain.",inputSchema:{type:"object",required:["symbol"],properties:{symbol:{type:"string"}}},readOnlyHint:true},
 {name:"crypto_orderbook",title:"Carnet Bybit Spot et murs",description:"Carnet d'ordres public: bid/ask, spread, principaux murs et déséquilibre du volume, sans manipulation d'ordre réel.",inputSchema:{type:"object",required:["symbol"],properties:{symbol:{type:"string"},limit:{type:"integer",enum:[25,50,100,200]}}},readOnlyHint:true},
 {name:"crypto_recent_trades",title:"Trades publics Bybit Spot",description:"Dernières exécutions de marché publiques Bybit EU Spot, sans données privées de compte.",inputSchema:{type:"object",required:["symbol"],properties:{symbol:{type:"string"},limit:{type:"integer",minimum:1,maximum:60}}},readOnlyHint:true},
 {name:"crypto_internet_news",title:"Recherche internet crypto (sources vérifiées)",description:"Recherche des titres d'actualités dans les flux publics CoinDesk ou Cointelegraph via HTTPS; sources allowlist, pas de navigation arbitraire ni d'accès privé.",inputSchema:{type:"object",properties:{source:{type:"string",enum:["coindesk","cointelegraph"]},search:{type:"string",maxLength:60},limit:{type:"integer",minimum:1,maximum:20}}},readOnlyHint:true}
];
export function createCryptoMarket({fetchImpl=globalThis.fetch, clock=Date.now}={}) {
  let lastNews= new Map();
  async function json(path) {
    if(!/^\/v5\/market\/(?:kline|orderbook|recent-trade)\?/.test(path)) throw Error("invalid_market_route");
    const c=new AbortController(),t=setTimeout(()=>c.abort(),12500);
    try {
      const response=await fetchImpl(BASE+path,{method:"GET",redirect:"error",signal:c.signal,headers:{"accept":"application/json"}});
      if(!response.ok)throw Error("market_http_"+response.status);
      const data=await response.json();
      if(data.retCode!==0)throw Error("bybit_return_"+String(data.retCode));
      return data.result||{};
    } finally {clearTimeout(t);}
  }
  function validateSymbol(args){const symbol=String(args?.symbol||"").toUpperCase().replace("/","");if(!SYMBOL.test(symbol))throw Error("invalid_symbol");return symbol;}
  async function chart(args={}) {
    const symbol=validateSymbol(args),interval=String(args.interval||"60").toUpperCase(),limit=cap(args.limit,40,240,120);
    if(!INTERVALS.has(interval))throw Error("invalid_timeframe");
    const root=await json("/v5/market/kline?category=spot&symbol="+encodeURIComponent(symbol)+"&interval="+interval+"&limit="+limit);
    const data=(root.list||[]).map(a=>({
      timestamp:safeNumber(a[0]),open:safeNumber(a[1]),high:safeNumber(a[2]),low:safeNumber(a[3]),
      close:safeNumber(a[4]),volume:safeNumber(a[5]),turnover:safeNumber(a[6])
    })).filter(x=>x.timestamp>0&&x.close>0).sort((a,b)=>a.timestamp-b.timestamp);
    if(data.length<2)throw Error("insufficient_candles");
    return {source:"Bybit EU V5 public Spot",symbol,interval,scanned_at:new Date(clock()).toISOString(),bars:data.length,
      latest:data.at(-1),first:data[0].timestamp,indicators:indicators(data),
      last_40_bars:data.slice(-40),exchange_credentials_used:false,trading_enabled:false,
      warning:"Indicateurs descriptifs; aucune certitude de rentabilité ni garantie de revenus."};
  }
  async function multi(args={}) {
    const symbol=validateSymbol(args);
    const timeframes=["1","5","15","60","240","D","W"];
    const results=[];
    for(const interval of timeframes) {
      try {
        const a=await chart({symbol,interval,limit:125});
        results.push({interval,ok:true,captured:a.scanned_at,price:a.latest.close,indicators:a.indicators,bars:a.bars});
      } catch(error){results.push({interval,ok:false,error:String(error.message).slice(0,120)});}
    }
    return {symbol,source:"Bybit EU Spot",checked_at:new Date(clock()).toISOString(),timeframes:results,complete:results.every(t=>t.ok)};
  }
  async function orderbook(args={}) {
    const symbol=validateSymbol(args),limit=Number(args.limit||50);
    if(![25,50,100,200].includes(limit))throw Error("invalid_limit");
    const data=await json("/v5/market/orderbook?category=spot&symbol="+symbol+"&limit="+limit);
    const convert=a=>(Array.isArray(a)?a:[]).map(x=>({price:safeNumber(x[0]),qty:safeNumber(x[1]),notional:safeNumber(x[0])*safeNumber(x[1])})).filter(x=>x.price>0&&x.qty>0);
    const bids=convert(data.b),asks=convert(data.a),bid=bids[0]?.price||0,ask=asks[0]?.price||0;
    const bTotal=bids.reduce((a,b)=>a+b.notional,0),aTotal=asks.reduce((a,b)=>a+b.notional,0);
    return {symbol,source:"Bybit EU Spot",checked_at:new Date(clock()).toISOString(),bid,ask,
      spread_pct:bid>0&&ask>0?round((ask-bid)/ask*100):null,
      depth_bid_notional:round(bTotal),depth_ask_notional:round(aTotal),
      imbalance_pct:bTotal+aTotal?round((bTotal-aTotal)/(bTotal+aTotal)*100):null,
      top_bid_walls:bids.sort((a,b)=>b.notional-a.notional).slice(0,12),
      top_ask_walls:asks.sort((a,b)=>b.notional-a.notional).slice(0,12),
      trading_enabled:false};
  }
  async function trades(args={}) {
    const symbol=validateSymbol(args),limit=cap(args.limit,1,60,30);
    const data=await json("/v5/market/recent-trade?category=spot&symbol="+symbol+"&limit="+limit);
    return {symbol,source:"Bybit EU public Spot",checked_at:new Date(clock()).toISOString(),
      items:(data.list||[]).slice(0,limit).map(x=>({timestamp:safeNumber(x.time),price:safeNumber(x.price),size:safeNumber(x.size),side:String(x.side||"")}))
    };
  }
  async function news(args={}) {
    const source=String(args.source||"coindesk"),search=String(args.search||"").trim().slice(0,60),limit=cap(args.limit,1,20,10);
    if(!Object.prototype.hasOwnProperty.call(NEWS,source))throw Error("invalid_source");
    if(lastNews.get(source)&&clock()-lastNews.get(source).at<120000) {
      const doc=lastNews.get(source);
      return {source,url:NEWS[source],checked_at:new Date(doc.at).toISOString(),items:headlines(doc.xml,search,limit),cached:true};
    }
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
    try {
      const res=await fetchImpl(NEWS[source],{method:"GET",redirect:"error",signal:ctrl.signal,headers:{accept:"application/rss+xml,text/xml,application/xml"}});
      if(!res.ok)throw Error("news_http_"+res.status);
      const xml=(await res.text()).slice(0,1024*1024);
      if(!xml.includes("<rss")&&!xml.includes("<item"))throw Error("news_not_rss");
      lastNews.set(source,{at:clock(),xml});
      return {source,url:NEWS[source],checked_at:new Date(clock()).toISOString(),items:headlines(xml,search,limit),cached:false};
    } finally {clearTimeout(timer);}
  }
  return {chart,multi,orderbook,trades,news};
}
