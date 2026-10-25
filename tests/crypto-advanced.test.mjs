import test from "node:test";
import assert from "node:assert/strict";
import {createCryptoMarket,marketTools} from "../src/crypto-market.mjs";
import {createCryptoMonitor,monitorTools} from "../src/crypto-monitor.mjs";
import {cryptoTools,createCryptoModule} from "../src/crypto.mjs";
import {buildServer} from "../src/server.mjs";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const prices=Array.from({length:120},(_,i)=>[String(1700000000000+i*60000),String(100+i/10-.1),String(101+i/10),String(99+i/10),String(100+i/10),String(1000+i),String(100000+i)]);
const response=data=>({ok:true,json:async()=>({retCode:0,result:data})});
async function fakeFetch(url) {
  const u=new URL(url);
  assert.equal(u.origin,"https://api.bybit.eu");
  if(u.pathname==="/v5/market/kline")return response({list:[...prices].reverse()});
  if(u.pathname==="/v5/market/orderbook")return response({b:[["100","2"],["99","5"]],a:[["101","3"],["102","4"]]});
  if(u.pathname==="/v5/market/recent-trade")return response({list:[{time:"1700000000010",price:"99",size:"0.1",side:"Buy"}]});
  throw Error("unexpected_route:"+url);
}
test("Full RSI MACD chart, orderbook and public trades without exchange keys",async()=>{
  const m=createCryptoMarket({fetchImpl:fakeFetch,clock:()=>1800000000000});
  const c=await m.chart({symbol:"BTCUSDC",interval:"60"});
  assert.equal(c.bars,120);
  assert.ok(c.indicators.ema20>0);
  assert.ok(c.indicators.ema50>0);
  assert.ok(c.indicators.rsi14>=0&&c.indicators.rsi14<=100);
  assert.ok(c.indicators.macd!==null);
  assert.equal(c.trading_enabled,false);
  const book=await m.orderbook({symbol:"BTCUSDC",limit:25});
  assert.equal(book.top_bid_walls.length,2);
  assert.ok(book.depth_bid_notional>0);
  assert.equal((await m.trades({symbol:"BTCUSDC"})).items[0].side,"Buy");
  await assert.rejects(()=>m.chart({symbol:"127.0.0.1"}),/invalid_symbol/);
  await assert.rejects(()=>m.news({source:"private-cloud"}),/invalid_source/);
  assert.equal(marketTools.length,5);
});
test("Opt-in market supervisor never executes trades and preserves thresholds",async()=>{
 const store={state:{},change:async(fn)=>fn(store.state)};
 let clock=1800000000000;
 const fakeCrypto={page:async({offset=0})=>({
   items:offset===0?[{symbol:"BTCUSDC",quoteCoin:"USDC",lastPrice:clock===1800000000000?"100":"106",turnover24h:110000,change24hPct:1},
   {symbol:"ETHUSDC",quoteCoin:"USDC",lastPrice:"2000",turnover24h:55000,change24hPct:-2}]:[],
   next_offset:null
 })};
 const sup=createCryptoMonitor(store,fakeCrypto,{clock:()=>clock});
 assert.equal(sup.status().enabled,false);
 const configured=await sup.config({enabled:true,symbols:["BTCUSDC"],interval_minutes:5,alert_change_pct:4});
 assert.equal(configured.symbols[0],"BTCUSDC");
 assert.equal((await sup.run()).state,"completed");
 clock+=6*60000;
 assert.equal((await sup.run()).state,"completed");
 assert.equal(sup.events().events.length,1);
 assert.equal(sup.events().events[0].change_pct,6);
 assert.equal(sup.status().trading,false);
 await assert.rejects(()=>sup.config({enabled:true,symbols:["127.0.0.1"]}),/invalid_symbols/);
 assert.equal(monitorTools.length,5);
 const radar=await sup.radar({quote:"USDC"});
 assert.equal(radar.full_universe_scanned,true);
 assert.equal(radar.trades_executed,0);
});
test("Universal MCP advertises unique tools and requires OAuth authorization",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"chk-mcp-advanced-"));
 const {server}=await buildServer({base:"http://localhost:8787",host:"127.0.0.1",port:0,
   adminPassword:"test-password-of-sufficient-length",jwtSecret:"a".repeat(64),
   file:join(dir,"state.json"),ollamaUrl:"",legacyUrl:""});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const root="http://127.0.0.1:"+server.address().port;
 const login=await fetch(root+"/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:"test-password-of-sufficient-length"})});
 const token=(await login.json()).access_token;
 const unauth=await fetch(root+"/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
 assert.equal(unauth.status,401);
 const res=await fetch(root+"/mcp",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
 const tools=(await res.json()).result.tools;
 const names=tools.map(t=>t.name);
 assert.equal(new Set(names).size,names.length,"duplicate MCP tools would break ChatGPT discovery");
 for(const n of ["crypto_market_chart","crypto_internet_news","crypto_radar","crypto_monitor_config","crypto_chart_control","crypto_device_status"]){
   assert.ok(names.includes(n),n);
 }
 const control=tools.find(t=>t.name==="crypto_chart_control");
 assert.equal(control.annotations.readOnlyHint,false);
 assert.deepEqual(control.securitySchemes[0].scopes,["mcp:write"]);
});
