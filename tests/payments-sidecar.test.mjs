import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaymentSidecar } from "../payments/sidecar.mjs";

async function setup(t) {
  const root=await mkdtemp(join(tmpdir(),"chk-payments-sidecar-"));
  const token="payments_mcp_read_only_secure_token_1234567890";
  const {server,devices}=await buildPaymentSidecar({
    port:0,host:"127.0.0.1",
    dataFile:join(root,"orders.json"),
    devicesFile:join(root,"devices.json"),
    mcpReadToken:token
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const request=async(path,options={})=>fetch(base+path,{
    method:options.method||"GET",
    headers:{...(options.json?{"content-type":"application/json"}:{}),
      ...(options.token?{authorization:"Bearer "+options.token}:{}),
      ...(options.headers||{})},
    body:options.json?JSON.stringify(options.json):undefined
  });
  return {devices,token,request};
}

test("CHK Paiements is isolated: no existing Universal Control /mcp service is touched", async t=>{
  const {request}=await setup(t);
  assert.equal((await request("/health")).status,200);
  assert.equal((await request("/api/v1/activity")).status,401);
  assert.equal((await request("/mcp",{method:"POST",json:{jsonrpc:"2.0",method:"tools/list",id:1}})).status,401);
  assert.equal((await request("/api/apps")).status,404);
  assert.equal((await request("/oauth/token",{method:"POST",json:{}})).status,404);
});

test("Pairing code is unique, owner access is revocable, no admin password on phone",async t=>{
  const {devices,request}=await setup(t);
  const pairCode=await devices.generateCode();
  assert.match(pairCode,/^[a-f0-9]{48}$/);
  const wrong=await request("/api/v1/pair",{method:"POST",json:{code:"0".repeat(48)}});
  assert.equal(wrong.status,403);
  const reply=await request("/api/v1/pair",{method:"POST",json:{code:pairCode,device_name:"Téléphone propriétaire"}});
  assert.equal(reply.status,201);
  const device=await reply.json();
  assert.match(device.device_token,/^chkpay_/);
  assert.ok(!(await request("/api/v1/pair",{method:"POST",json:{code:pairCode}})).ok);
  const auth=await request("/api/v1/activity",{token:device.device_token});
  assert.equal(auth.status,200);
  assert.deepEqual((await auth.json()).items,[]);
  await devices.revoke(device.device_id);
  assert.equal((await request("/api/v1/activity",{token:device.device_token})).status,401);
});

test("Dedicated MCP exposes payments-only read tools and rejects writes",async t=>{
  const {request,token}=await setup(t);
  const rpc=async(method,params)=> {
    const reply=await request("/mcp",{method:"POST",token,json:{jsonrpc:"2.0",id:3,method,params}});
    assert.equal(reply.status,200);
    return reply.json();
  };
  const init=await rpc("initialize",{});
  assert.equal(init.result.serverInfo.name,"CHK Paiements");
  const toolList=await rpc("tools/list",{});
  assert.deepEqual(toolList.result.tools.map(x=>x.name),["payments_status","payments_activity","payments_summary","payments_review_queue"]);
  const status=await rpc("tools/call",{name:"payments_status",arguments:{}});
  assert.match(status.result.content[0].text,/"orders":0/);
  const bad=await rpc("tools/call",{name:"payments_review_order",arguments:{order_id:"123",decision:"approve"}});
  assert.equal(bad.error.code,-32601);
});

test("Stripe webhook without configured secret rejects unauthenticated notifications",async t=>{
  const {request}=await setup(t);
  const res=await request("/api/v1/stripe/webhook",{method:"POST",json:{type:"checkout.session.completed"}});
  assert.equal(res.status,503);
  assert.equal((await res.json()).error,"stripe_webhook_not_configured");
});
