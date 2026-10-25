import test from "node:test";
import assert from "node:assert/strict";
import { createMarketResearch,calculateIndicators,normalizedPair,asReadOnly } from "../src/crypto-markets.mjs";
import { createCryptoModule,cryptoTools } from "../src/crypto.mjs";
const makeResponse=data=>({ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({retCode:0,result:data})});
const candles=Array.from({length:150},(_,i)=>{
 const close=100+i*.1+Math.sin(i/8);
 return [String(1700000000000+i*60000),String(close-.15),String(close+1),String(close-1),String(close),String(1000+i),String(100000+i*100)];
});
const sampleTickers=[{symbol:"BTCUSDC",lastPrice:"101.5",bid1Price:"101.4",ask1Price:"101.6",price24hPcnt:"0.04",turnover24h:"50000",volume24h:"500"},
 {symbol:"ETHUSDC",lastPrice:"2500",price24hPcnt:"-0.02",turnover24h:"11000"}];
function mock(url) {
 const u=new URL(url);
 assert.equal(u.origin,"https://api.bybit.eu");
 const path=u.pathname;
 if(path==="/v5/market/tickers")return makeResponse({list:sampleTickers});
 if(path==="/v5/market/kline")return makeResponse({list:candles.slice().reverse()});
 if(path==="/v5/market/instruments-info")return makeResponse({list:[{symbol:"BTCUSDC",baseCoin:"BTC",quoteCoin:"USDC",status:"Trading",lotSizeFilter:{minOrderAmt:"1"},priceFilter:{tickSize:"0.01"}}]});
 if(path==="/v5/market/orderbook")return makeResponse({b:[["101.4","10"]],a:[["101.6","12"]],ts:1700000000000});
 throw Error("unexpected_api:"+url);
}
test("public Bybit read-only market tooling",async()=>{
 const m=createMarketResearch({fetchImpl:mock,now:()=>1800000000000});
 assert.equal((await m.ticker({symbol:"btc/usdc"})).symbol,"BTCUSDC");
 assert.equal((await m.orderbook({symbol:"BTCUSDC"})).bids.length,1);
 assert.equal((await m.candles({symbol:"BTCUSDC",interval:"60"})).items.length,150);
 const indicators=await m.indicators({symbol:"BTCUSDC",interval:"60"});
 assert.ok(indicators.rsi14>=0&&indicators.rsi14<=100);
 assert.ok(indicators.ema20>0&&indicators.ema50>0);
 assert.ok(indicators.support30<indicators.resistance30);
 assert.equal((await m.multi({symbol:"BTCUSDC"})).results.length,4);
 assert.equal((await m.rules({symbol:"BTCUSDC"})).lotSizeFilter.minOrderAmt,"1");
 assert.equal((await m.movers({sort:"turnover"})).items[0].symbol,"BTCUSDC");
 assert.ok(asReadOnly.length>=8&&asReadOnly.every(t=>t.readOnlyHint));
 assert.throws(()=>normalizedPair("ETHUSDT"),/invalid_spot/);
 await assert.rejects(()=>m.webRead({url:"http://127.0.0.1:8787"}),/not_allowlisted/);
 await assert.rejects(()=>m.webRead({url:"https://evil.example/"}),/not_allowlisted/);
});
test("indicators reject missing history instead of fake certainty",()=>{
 assert.throws(()=>calculateIndicators([{close:4,high:6,low:2,volume:1}]),/insufficient/);
});
test("scanner reads ALL spot instruments without limit pagination",async()=>{
 const paths=[];
 const fetchImpl=async url=>{
   paths.push(url);
   const u=new URL(url);
   if(u.pathname==="/v5/market/instruments-info")return makeResponse({list:[
     {symbol:"BTCUSDC",status:"Trading",baseCoin:"BTC",quoteCoin:"USDC"},
     {symbol:"ETHUSDC",status:"Trading",baseCoin:"ETH",quoteCoin:"USDC"},
     {symbol:"DOGEUSDT",status:"Trading",baseCoin:"DOGE",quoteCoin:"USDT"}
   ]});
   if(u.pathname==="/v5/market/tickers")return makeResponse({list:sampleTickers});
   throw Error("unexpected_url");
 };
 const oldFetch=globalThis.fetch;
 globalThis.fetch=fetchImpl;
 try{
   const m=createCryptoModule({state:{apps:{}},listApps:()=>[],getJob:()=>null},{now:()=>1800000000000});
   const scan=await m.scan({});
   assert.equal(scan.total_spot_pairs,3);
   assert.equal(scan.unique_spot_cryptos,3);
   assert.equal(scan.usdc_pairs,2);
   const page=await m.page({quote:"USDC",offset:0,limit:1});
   assert.equal(page.total,2);
   assert.equal(page.next_offset,1);
   assert.ok(paths.every(x=>!x.includes("limit=")&&!x.includes("cursor=")));
   assert.equal(m.status().registered,false);
   assert.deepEqual(cryptoTools.every(t=>t.readOnlyHint),true);
 }finally{globalThis.fetch=oldFetch;}
});
