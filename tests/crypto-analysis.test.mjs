import test from "node:test";
import assert from "node:assert/strict";
import {createCryptoIntelligence,analyzeCandles} from "../src/crypto-analysis.mjs";

const synthetic=Array.from({length:200},(_,i)=>{
  const close=50000+i*11+Math.sin(i/7)*140;
  return {time:Date.UTC(2026,0,1)+i*60000,open:close-15,high:close+50,
    low:close-70,close,volume:90+i,turnover:close*(90+i)};
});
test("technical analysis computes indicators on valid sorted OHLCV without orders",()=>{
  const result=analyzeCandles("BTCUSDC","60",synthetic);
  assert.equal(result.ok,true);
  assert.equal(result.candleCount,200);
  assert.ok(result.rsi14>30 && result.rsi14<100);
  assert.ok(result.ema20>0 && result.ema50>0);
  assert.ok(result.macd.line!==null);
  assert.ok(result.macd.signal!==null);
  assert.ok(result.bollinger20.upper>result.bollinger20.middle);
  assert.ok(result.atr14>0);
  assert.equal(result.priceSeries.length,20);
  assert.equal(result.tradeRecommended,false);
  assert.equal(result.financialAdvice,false);
  assert.equal(result.latestCandleTimestamp,new Date(synthetic.at(-1).time).toISOString());
});
test("chart data is fetched from fixed Bybit EU origin, cached and multi-timeframes bounded",async()=>{
  const calls=[];
  const fetchImpl=async url=>{
    calls.push(url);
    assert.ok(url.startsWith("https://api.bybit.eu/v5/market/kline?category=spot&symbol=BTCUSDC&"));
    return {ok:true,json:async()=>({retCode:0,result:{list:[...synthetic].reverse().map(c=>[
      String(c.time),String(c.open),String(c.high),String(c.low),String(c.close),
      String(c.volume),String(c.turnover)])}})};
  };
  const intel=createCryptoIntelligence({fetchImpl,now:()=>Date.UTC(2026,0,1)});
  const first=await intel.chart({symbol:"BTCUSDC",timeframe:"60"});
  assert.equal(first.ok,true);
  assert.equal(first.candleCount,200);
  await intel.chart({symbol:"BTCUSDC",timeframe:"60"});
  assert.equal(calls.length,1);
  const multi=await intel.multi({symbol:"BTCUSDC",timeframes:["60","D"]});
  assert.equal(multi.analyses.length,2);
  assert.equal(calls.length,2);
  await assert.rejects(intel.chart({symbol:"http://127.0.0.1"}),/crypto_invalid_symbol/);
  await assert.rejects(intel.multi({symbol:"BTCUSDC",timeframes:Array(7).fill("1")}),/crypto_invalid_timeframes/);
});
test("crypto news parse public RSS only, never arbitrary user URLs",async()=>{
  const xml='<?xml version="1.0"?><rss><channel><item>'+
    '<title>Bitcoin &amp; Bybit EU news</title>'+
    '<link>https://news.example.com/crypto/article</link>'+
    '<description>Market moves &lt;today&gt;</description>'+
    '<pubDate>Sun, 25 Oct 2026 16:00:00 GMT</pubDate>'+
    '</item></channel></rss>';
  let requestedUrl="";
  const intel=createCryptoIntelligence({fetchImpl:async url=>{
    requestedUrl=url;
    return {ok:true,text:async()=>xml};
  }});
  const data=await intel.news({query:"Bitcoin prix",limit:5});
  assert.equal(data.count,1);
  assert.match(data.articles[0].title,/Bitcoin & Bybit/);
  assert.ok(requestedUrl.startsWith("https://www.bing.com/news/search?"));
  await assert.rejects(intel.news({query:"<script>bad"}),/crypto_invalid_query/);
});
test("read-only financial page browser rejects private/local hosts, redirects, and arbitrary domains",async()=>{
  const seen=[];
  const intel=createCryptoIntelligence({fetchImpl:async (url,opts)=>{
    seen.push({url,opts});
    return {ok:true,headers:{get:()=> "text/html; charset=utf-8"},text:async()=>'<html><title>BTC market</title><body><h1>Public source</h1>Text</body></html>'};
  }});
  const page=await intel.openPublicPage({url:"https://www.coingecko.com/en/coins/bitcoin"});
  assert.equal(page.ok,true);
  assert.equal(page.title,"BTC market");
  assert.equal(seen[0].opts.redirect,"error");
  assert.equal(seen.length,1);
  for(const url of ["http://127.0.0.1:8787","https://localhost/test","https://internal.example.com/",
    "https://www.coingecko.com.evil.org","https://www.coingecko.com:8443/",
    "https://www.coingecko.com@private.example.com/"]){
    await assert.rejects(intel.openPublicPage({url}),/crypto_public_domain_not_allowed/);
  }
});

test("fixed-origin Spot market tools inspect ticker, orderbook, trades and trading rules",async()=>{
  const calls=[];
  const intel=createCryptoIntelligence({fetchImpl:async url=>{
    calls.push(url);
    let data;
    if(url.includes("/tickers?")) data={list:[{symbol:"BTCUSDC",lastPrice:"67200",bid1Price:"67199",
      ask1Price:"67201",price24hPcnt:"0.02",volume24h:"100",turnover24h:"6710000",
      highPrice24h:"68000",lowPrice24h:"65000"}]};
    else if(url.includes("/orderbook?")) data={b:[["67199","1"],["67198","2"]],
      a:[["67201","1"],["67202","3"]],ts:1792900000000};
    else if(url.includes("/recent-trade?")) data={list:[
      {S:"Buy",p:"67200",v:"0.5",T:1792900000000},
      {S:"Sell",p:"67199",v:"0.2",T:1792900000001}]};
    else if(url.includes("/instruments-info?")) data={list:[{symbol:"BTCUSDC",status:"Trading",
      baseCoin:"BTC",quoteCoin:"USDC",priceFilter:{tickSize:"0.1"},
      lotSizeFilter:{minOrderAmt:"5",basePrecision:"0.00001"}}]};
    else throw Error("Unexpected URL");
    return {ok:true,json:async()=>({retCode:0,result:data})};
  }});
  const t=await intel.ticker({symbol:"BTCUSDC"});
  assert.equal(t.lastPrice,67200);
  assert.equal(t.readOnly,true);
  const b=await intel.orderbook({symbol:"BTCUSDC",depth:50});
  assert.ok(b.spreadPct>0);
  assert.ok(b.bidLiquidityRatioPct>0 && b.bidLiquidityRatioPct<100);
  assert.equal(b.bestBid,67199);
  const trades=await intel.recentTrades({symbol:"BTCUSDC"});
  assert.equal(trades.buyTradeCount,1);
  assert.equal(trades.sellTradeCount,1);
  const rule=await intel.instrumentRules({symbol:"BTCUSDC"});
  assert.equal(rule.tickSize,"0.1");
  assert.equal(rule.realOrdersBlockedInMCP,true);
  assert.equal(calls.length,4);
  assert.ok(calls.every(url=>url.startsWith("https://api.bybit.eu/")));
  await assert.rejects(intel.orderbook({symbol:"BTCUSDC",depth:999}),/crypto_invalid_depth/);
});
