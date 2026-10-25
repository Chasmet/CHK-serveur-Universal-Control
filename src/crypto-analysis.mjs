/**
 * Isolated market intelligence tools for CHK Crypto Analyse 2.
 * Read-only HTTPS from fixed Bybit EU & Bing News origins (no arbitrary SSRF).
 */
const BASE = "https://api.bybit.eu";
const TF = new Set(["1","3","5","15","30","60","120","240","360","720","D","W","M"]);
const MAX_URL_CONTENT = 32_000;

const round = (v,n=5) => v==null || !Number.isFinite(v) ? null : Number(v.toFixed(n));
function ema(values, period) {
  if (values.length < period) return null;
  const k=2/(period+1);
  let out=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++) out=values[i]*k+out*(1-k);
  return out;
}
function emaSeries(values,period) {
  const out=Array(values.length).fill(null);
  if(values.length<period) return out;
  let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period-1]=v;
  for(let i=period;i<values.length;i++) out[i]=v=values[i]*2/(period+1)+v*(1-2/(period+1));
  return out;
}
function rsi(closes,period=14) {
  if(closes.length<=period)return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];gains+=Math.max(0,d);losses+=Math.max(0,-d);}
  gains/=period;losses/=period;
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    gains=(gains*(period-1)+Math.max(0,d))/period;
    losses=(losses*(period-1)+Math.max(0,-d))/period;
  }
  return losses===0?(gains===0?50:100):100-100/(1+gains/losses);
}
function bollinger(closes,period=20) {
  if(closes.length<period)return null;
  const s=closes.slice(-period);
  const mean=s.reduce((a,b)=>a+b,0)/period;
  const variance=s.reduce((a,b)=>a+(b-mean)**2,0)/period;
  const deviation=Math.sqrt(variance);
  return {lower:round(mean-2*deviation),middle:round(mean),upper:round(mean+2*deviation)};
}
function atr(candles,period=14) {
  if(candles.length<=period)return null;
  const tr=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],prev=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close)));
  }
  if(tr.length<period)return null;
  let value=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++)value=(value*(period-1)+tr[i])/period;
  return value;
}
function macd(closes) {
  const fast=emaSeries(closes,12),slow=emaSeries(closes,26);
  const diffs=[];
  for(let i=0;i<closes.length;i++){if(fast[i]!=null&&slow[i]!=null)diffs.push(fast[i]-slow[i]);}
  if(!diffs.length)return null;
  const line=diffs.at(-1);
  const signal=ema(diffs,9);
  return {line:round(line),signal:round(signal),histogram:signal===null?null:round(line-signal)};
}
function normalizeSymbol(s) {
  const raw=String(s||"").toUpperCase().replace(/[/ _-]/g,"");
  if(!/^[A-Z0-9]{4,32}$/.test(raw))throw Error("crypto_invalid_symbol");
  return raw;
}
async function jsonGet(fetchImpl,url,maxMs=10000) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),maxMs);
  try{
    const response=await fetchImpl(url,{method:"GET",redirect:"error",signal:controller.signal,headers:{accept:"application/json","user-agent":"CHK-Univ-ReadOnly/1.0"}});
    if(!response.ok)throw Error("crypto_http_"+response.status);
    const body=await response.json();
    if(Number(body.retCode)!==0)throw Error("crypto_bybit_api_"+body.retCode);
    return body.result;
  } finally{clearTimeout(timer);}
}
function parseKlines(root) {
  if(!Array.isArray(root?.list))throw Error("crypto_chart_missing");
  const seen=new Set();
  return root.list.map(a=>{
    if(!Array.isArray(a)||a.length<7)return null;
    const c={time:Number(a[0]),open:Number(a[1]),high:Number(a[2]),low:Number(a[3]),close:Number(a[4]),volume:Number(a[5]),turnover:Number(a[6])};
    if(!Number.isFinite(c.time)||Object.entries(c).filter(([k])=>k!=="time").some(([,v])=>!Number.isFinite(v)||v<0)||
      c.high<c.low||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||seen.has(c.time))return null;
    seen.add(c.time);
    return c;
  }).filter(Boolean).sort((a,b)=>a.time-b.time);
}
export function analyzeCandles(symbol,timeframe,candles) {
  if(candles.length<40)return {ok:false,error:"crypto_chart_not_enough_candles",available:candles.length};
  const closes=candles.map(c=>c.close);
  const last=candles.at(-1),prev=candles.at(-2);
  const e20=ema(closes,20),e50=ema(closes,50);
  const r=rsi(closes),bands=bollinger(closes),range=atr(candles),m=macd(closes);
  const delta=prev.close?100*(last.close/prev.close-1):null;
  const last20=candles.slice(-20);
  const support=Math.min(...last20.map(c=>c.low)),resistance=Math.max(...last20.map(c=>c.high));
  let momentum=0;
  if(e20!==null&&e50!==null)momentum+=e20>=e50?1:-1;
  if(m?.histogram!==null&&m?.histogram!==undefined)momentum+=m.histogram>=0?1:-1;
  if(r!==null){if(r>=70)momentum-=1;else if(r<=30)momentum+=1;}
  return {
    ok:true,source:BASE,market:"spot",symbol,timeframe,candleCount:candles.length,
    latestCandleTimestamp:new Date(last.time).toISOString(),lastClose:round(last.close,8),
    lastCandleChangePct:round(delta,2),volume:round(last.volume,3),
    ema20:round(e20,8),ema50:round(e50,8),rsi14:round(r,2),bollinger20:bands,
    atr14:round(range,8),macd:m,
    support20:round(support,8),resistance20:round(resistance,8),
    trend:momentum>0?"HAUSSIER_INDICATIF":momentum<0?"BAISSIER_INDICATIF":"NEUTRE",
    indicatorsOnly:true,financialAdvice:false,tradeRecommended:false,
    priceSeries:last20.map(c=>({time:new Date(c.time).toISOString(),close:round(c.close,8),volume:round(c.volume,3)})),
    warning:"Analyse d'indicateurs historiques, non prédictive. La dernière bougie peut être incomplète. Aucune opération réelle."
  };
}
function decodeXml(s) {
  return String(s).replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&amp;/g,"&").replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
}
function stripTags(s,max=450) {return decodeXml(String(s).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()).slice(0,max);}
const pageHosts=new Set(["www.bybit.com","announcements.bybit.com","www.binance.com","academy.binance.com",
  "www.coingecko.com","www.coinmarketcap.com","www.reuters.com","www.investing.com"]);
export function createCryptoIntelligence({fetchImpl=fetch,now=Date.now}={}) {
  const chartCache=new Map();
  async function chart(input={}) {
    const symbol=normalizeSymbol(input.symbol);
    const timeframe=String(input.timeframe||"60").toUpperCase();
    if(!TF.has(timeframe))throw Error("crypto_invalid_timeframe");
    const key=symbol+"|"+timeframe;
    let cache=chartCache.get(key);
    if(!cache||now()-cache.at>Math.max(30000,({"1":30000,"3":45000,"5":60000})[timeframe]||120000)){
      const root=await jsonGet(fetchImpl,BASE+"/v5/market/kline?category=spot&symbol="+symbol+
        "&interval="+timeframe+"&limit=200");
      cache={at:now(),candles:parseKlines(root)};
      if(chartCache.size>150)chartCache.delete(chartCache.keys().next().value);
      chartCache.set(key,cache);
    }
    return {...analyzeCandles(symbol,timeframe,cache.candles),retrievedAt:new Date(cache.at).toISOString()};
  }
  async function multi(input={}) {
    const symbol=normalizeSymbol(input.symbol);
    const frames=Array.isArray(input.timeframes)?input.timeframes:["5","15","60","D"];
    if(!frames.length||frames.length>6||frames.some(x=>!TF.has(String(x).toUpperCase()))||
       new Set(frames).size!==frames.length)throw Error("crypto_invalid_timeframes");
    const analyses=await Promise.all(frames.map(async timeframe=>{
      try{return await chart({symbol,timeframe});}
      catch(error){return {symbol,timeframe,ok:false,error:String(error.message||error)};}
    }));
    return {ok:analyses.some(x=>x.ok),symbol,analyses,
      agreement:analyses.filter(x=>x.ok).map(x=>x.trend).filter(x=>x==="HAUSSIER_INDICATIF").length>=3?"HAUSSIER_INDICATIF":
        analyses.filter(x=>x.ok).map(x=>x.trend).filter(x=>x==="BAISSIER_INDICATIF").length>=3?"BAISSIER_INDICATIF":"MIXTE",
      noAutoOrders:true};
  }
  async function news(input={}) {
    const terms=String(input.query||"Bybit crypto market").trim();
    if(terms.length<2||terms.length>100||/[<>]/.test(terms))throw Error("crypto_invalid_query");
    const count=Number(input.limit??8);
    if(!Number.isInteger(count)||count<1||count>15)throw Error("crypto_invalid_limit");
    // No arbitrary URL is passed to fetch; only public Microsoft Bing RSS.
    const url="https://www.bing.com/news/search?q="+encodeURIComponent(terms)+"&format=rss&setlang=fr";
    const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),10000);
    try{
      const response=await fetchImpl(url,{method:"GET",signal:ctl.signal,redirect:"error",
        headers:{accept:"application/rss+xml, application/xml, text/xml"}});
      if(!response.ok)throw Error("crypto_news_http_"+response.status);
      const xml=(await response.text()).slice(0,160000);
      const records=[];
      for(const item of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
        if(records.length>=count)break;
        const body=item[1];
        const get=(tag)=>{const match=new RegExp("<"+tag+"[^>]*>(.*?)</"+tag+">","is").exec(body);
          return match?match[1].replace(/^<!\[CDATA\[/,"").replace(/\]\]>$/,""):"";};
        const link=decodeXml(get("link")).trim();
        let u;try{u=new URL(link);if(u.protocol!=="https:")continue;}catch{continue;}
        records.push({title:stripTags(get("title")),url:u.href,source:stripTags(get("source")),
          published:get("pubDate").slice(0,100),summary:stripTags(get("description"))});
      }
      return {ok:true,source:"Bing News RSS",query:terms,articles:records,
        count:records.length,requiresCrossChecking:true,externalContentUntrusted:true};
    }finally{clearTimeout(timer);}
  }
  async function openPublicPage(input={}) {
    const raw=String(input.url||"");let parsed;
    try{parsed=new URL(raw);}catch{throw Error("crypto_invalid_url");}
    if(parsed.protocol!=="https:"||!pageHosts.has(parsed.hostname.toLowerCase())||parsed.username||
      parsed.password||parsed.port||parsed.hash||raw.length>2048)throw Error("crypto_public_domain_not_allowed");
    const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),10000);
    try{
      const resp=await fetchImpl(parsed.href,{method:"GET",redirect:"error",signal:ctl.signal,
        headers:{accept:"text/html","user-agent":"CHK Crypto Analyse 2 ReadOnly"}});
      if(!resp.ok)throw Error("crypto_article_http_"+resp.status);
      const contentType=resp.headers?.get("content-type")||"";
      if(!contentType.includes("html"))throw Error("crypto_article_not_html");
      const html=(await resp.text()).slice(0,MAX_URL_CONTENT*2);
      const title=stripTags((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)||[])[1]||"");
      const text=stripTags(html.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi," ").slice(0,MAX_URL_CONTENT),3000);
      return {ok:true,source:parsed.hostname,url:parsed.href,title,excerpt:text.slice(0,3000),
        externalContentUntrusted:true,readOnly:true};
    }finally{clearTimeout(timer);}
  }
  return {chart,multi,news,openPublicPage};
}
