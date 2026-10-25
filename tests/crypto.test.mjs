import test from "node:test";
import assert from "node:assert/strict";
import {createCryptoModule,cryptoToolDefinitions} from "../src/crypto.mjs";

function fake() {
  const calls=[];
  const instruments=[
    {symbol:"BTCUSDC",baseCoin:"BTC",quoteCoin:"USDC",status:"Trading",lotSizeFilter:{minOrderAmt:"5"}},
    {symbol:"ETHUSDC",baseCoin:"ETH",quoteCoin:"USDC",status:"Trading"},
    {symbol:"BTCUSDT",baseCoin:"BTC",quoteCoin:"USDT",status:"Trading"},
    {symbol:"XRPUSDT",baseCoin:"XRP",quoteCoin:"USDT",status:"Trading"},
    {symbol:"PENDINGUSDC",baseCoin:"PENDING",quoteCoin:"USDC",status:"PendingOpen"}
  ];
  const tickers=[
    {symbol:"BTCUSDC",lastPrice:"67000",turnover24h:"900000",price24hPcnt:"0.04"},
    {symbol:"ETHUSDC",lastPrice:"3000",turnover24h:"800000",price24hPcnt:"-0.01"},
    {symbol:"BTCUSDT",lastPrice:"67200",turnover24h:"700000",price24hPcnt:"0.03"},
    {symbol:"XRPUSDT",lastPrice:"3",turnover24h:"30000",price24hPcnt:"0.05"}
  ];
  const fetchImpl=async url=>{calls.push(url);return {ok:true,json:async()=>({retCode:0,result:url.includes("instruments-info")?{list:instruments}:{list:tickers}})}};
  const apps=[];
  const tasks=[];
  const store={
    listApps:()=>apps,
    submit:async data=>{tasks.push(data);return {id:"id"+tasks.length,state:"queued"};}
  };
  return {module:createCryptoModule({store,fetchImpl}),calls,apps,tasks};
}
test("crypto tools never expose orders and every declared tool is read-only",()=>{
  assert.deepEqual(cryptoToolDefinitions.map(x=>x.name),[
    "crypto_status","crypto_scan_bybit","crypto_portfolio_snapshot","crypto_tracking_status"]);
  assert.ok(cryptoToolDefinitions.every(x=>x.readOnlyHint));
  assert.ok(!cryptoToolDefinitions.some(x=>/trade|cancel|withdraw/i.test(x.name)));
});
test("Bybit Spot ALL scans every available trading pair before filtering USDC/USDT",async()=>{
  const x=fake();
  const all=await x.module.run("crypto_scan_bybit",{});
  assert.equal(all.tradingPairs,4);
  assert.equal(all.uniqueBaseCoins,3);
  assert.equal(all.allQuotes.USDC,2);
  assert.equal(all.allQuotes.USDT,2);
  assert.equal(all.instrumentsReturned,5);
  assert.equal(all.markets[0].symbol,"BTCUSDC");
  assert.equal(x.calls.length,2);
  const usdc=await x.module.run("crypto_scan_bybit",{quote:"USDC",limit:1});
  assert.equal(usdc.matchingPairs,2);
  assert.equal(usdc.markets.length,1);
  assert.equal(usdc.markets[0].symbol,"BTCUSDC");
  assert.equal(x.calls.length,2,"must reuse cache, no wasteful new REST calls");
  const usdt=await x.module.run("crypto_scan_bybit",{quote:"USDT",minTurnoverUsd:50000});
  assert.equal(usdt.matchingPairs,1);
  assert.equal(usdt.markets[0].symbol,"BTCUSDT");
  await assert.rejects(x.module.run("crypto_scan_bybit",{limit:10000}),/crypto_invalid_limit/);
});
test("Without pairing no private tasks; only approved read-only capabilities queued",async()=>{
  const x=fake();
  const status=await x.module.run("crypto_status");
  assert.equal(status.paired,false);
  assert.equal((await x.module.run("crypto_portfolio_snapshot")).error,"crypto_android_not_paired");
  assert.equal(x.tasks.length,0);
  x.apps.push({id:"android-1",name:"CHK Crypto Analyse 2",connection:"worker",online:true,
    registered_at:12345,last_seen:12345,capabilities:[
      {name:"portfolio_snapshot",readOnly:true},{name:"tracking_status",readOnly:true}]});
  const online=await x.module.run("crypto_status");
  assert.equal(online.androidOnline,true);
  const queued=await x.module.run("crypto_portfolio_snapshot",{request_id:"unique"});
  assert.equal(queued.task_id,"id1");
  assert.equal(x.tasks[0].app_id,"android-1");
  assert.equal(x.tasks[0].action,"portfolio_snapshot");
  assert.deepEqual(x.tasks[0].args,{});
  await x.module.run("crypto_tracking_status");
  assert.equal(x.tasks[1].action,"tracking_status");
});
test("reject Bybit partial Spot catalogue with unexpected cursor",async()=>{
  const store={listApps:()=>[],submit:async()=>null};
  const module=createCryptoModule({store,fetchImpl:async url=>({
    ok:true,json:async()=>({retCode:0,result:url.includes("instruments-info")?
      {list:[{symbol:"BTCUSDC",status:"Trading",baseCoin:"BTC",quoteCoin:"USDC"}],nextPageCursor:"MORE"}:
      {list:[{symbol:"BTCUSDC",lastPrice:"1"}]}})
  })});
  await assert.rejects(module.run("crypto_scan_bybit"),/incomplete_market_catalogue/);
});
