import test from "node:test";
import assert from "node:assert/strict";
import {buildPublicPlayGateway} from "../payments/public-play-gateway.mjs";
const valid={packageName:"com.chk.blocnote",productId:"blocnote_premium_lifetime",
  purchaseToken:"token_google_1234567890abcdefghij"};
const create=async(t,fetchFn)=>{
  const {server}=buildPublicPlayGateway({port:0,fetchFn});
  await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
  t.after(()=>new Promise(ok=>server.close(ok)));
  return "http://127.0.0.1:"+server.address().port;
};
test("only Play verify and health accessible",async t=>{
  let passed=0;
  const base=await create(t,async(url,opts)=>{
    passed++;
    const x=url.endsWith("health")?{ok:true,billingReady:true}:{
      verified:true,packageName:valid.packageName,productId:valid.productId};
    return {status:200,text:async()=>JSON.stringify(x)};
  });
  for(const route of ["/mcp","/api/v1/activity","/api/v1/pair","/api/v1/stripe/webhook",
    "/api/v1/reviews","/api/v1/play/verify"]){
    assert.equal((await fetch(base+route)).status,404);
  }
  assert.equal(passed,0);
  assert.equal((await(await fetch(base+"/api/v1/play/health")).json()).billingReady,true);
  const reply=await fetch(base+"/api/v1/play/verify",{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify(valid)});
  assert.equal(reply.status,200);
  assert.equal((await reply.json()).verified,true);
  assert.equal(passed,2);
});
test("no wrong app, wrong SKU, spoofed approval or bad body",async t=>{
  const base=await create(t,async()=>({status:200,text:async()=>JSON.stringify({verified:true,packageName:"fake"})}));
  const post=x=>fetch(base+"/api/v1/play/verify",{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify(x)});
  assert.equal((await post({...valid,packageName:"com.bad.app"})).status,400);
  assert.equal((await post({...valid,productId:"rush_premium"})).status,400);
  assert.equal((await post({...valid,purchaseToken:"x".repeat(8300)})).status,413);
  assert.equal((await post(valid)).status,503);
});
test("gateway and sidecar must be bound locally",()=>{
  assert.throws(()=>buildPublicPlayGateway({host:"0.0.0.0"}),/loopback/);
  assert.throws(()=>buildPublicPlayGateway({upstream:"https://external.test"}),/upstream_must_be_local/);
});

test("public package Sync30 accepted, and response must match requested package",async t=>{
  let upstreamRequests=0;
  const base=await create(t,async(url,opts)=>{
    upstreamRequests++;
    const requested=JSON.parse(opts.body);
    return {status:200,text:async()=>JSON.stringify({
      verified:true,packageName:requested.packageName,productId:requested.productId
    })};
  });
  const publicPurchase={...valid,packageName:"com.sync30.mesnotesdossiers"};
  const post=x=>fetch(base+"/api/v1/play/verify",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(x)
  });
  const good=await post(publicPurchase);
  assert.equal(good.status,200);
  assert.equal((await good.json()).packageName,"com.sync30.mesnotesdossiers");
  assert.equal(upstreamRequests,1);
  assert.equal((await post({...publicPurchase,packageName:"com.attacker.app"})).status,400);
});
test("public request cannot be validated by a personal-package response",async t=>{
  const base=await create(t,async()=>({status:200,text:async()=>JSON.stringify({
    verified:true,packageName:"com.chk.blocnote",productId:"blocnote_premium_lifetime"
  })}));
  const result=await fetch(base+"/api/v1/play/verify",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({...valid,packageName:"com.sync30.mesnotesdossiers"})
  });
  assert.equal(result.status,503);
});
