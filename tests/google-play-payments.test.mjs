import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GooglePlayVerifier } from "../payments/google-play-verifier.mjs";
import { buildPaymentSidecar } from "../payments/sidecar.mjs";

const token="Purchase_Token_Test_12345678901234567890";
const valid={
  packageName:"com.chk.blocnote",
  productId:"blocnote_premium_lifetime",
  purchaseToken:token
};
const hash=s=>createHash("sha256").update(s).digest("hex");

test("aucune configuration Google : santé désactivée et produit bloqué",async()=>{
  const verifier=new GooglePlayVerifier({env:{},enabled:false});
  assert.equal(await verifier.ready(),false);
  await assert.rejects(()=>verifier.verify(valid),/google_play_not_configured/);
});

test("validation côté Google : acheté oui, pending/non correspondant non",async()=>{
  const key=generateKeyPairSync("rsa",{modulusLength:2048});
  const serviceAccount={
    client_email:"fake-service-account@example.invalid",
    private_key:key.privateKey.export({format:"pem",type:"pkcs8"})
  };
  let state="PURCHASED";
  let productId="blocnote_premium_lifetime";
  let consumption="CONSUMPTION_STATE_YET_TO_BE_CONSUMED";
  let oauthCount=0;
  const fetchFn=async(url,opt)=>{
    if(url.includes("oauth2.googleapis.com")){
      oauthCount++;
      assert.equal(opt.method,"POST");
      assert.match(opt.body,/assertion=/);
      return {ok:true,json:async()=>({access_token:"token_test_google_play_12345",expires_in:3600})};
    }
    assert.match(url,/applications\/com.chk.blocnote\/purchases\/productsv2\/tokens\//);
    assert.equal(opt.headers.authorization,"Bearer token_test_google_play_12345");
    return {ok:true,status:200,json:async()=>({
      purchaseStateContext:{purchaseState:state},
      productLineItem:[{productId,productOfferDetails:{consumptionState:consumption}}],
      acknowledgementState:"ACKNOWLEDGEMENT_STATE_PENDING"
    })};
  };
  const verifier=new GooglePlayVerifier({enabled:true,serviceAccount,fetchFn});
  assert.equal(await verifier.ready(),true);
  const bought=await verifier.verify(valid);
  assert.equal(bought.verified,true);
  assert.equal(bought.tokenHash,hash(token));
  assert.equal(bought.packageName,"com.chk.blocnote");
  assert.equal(bought.acknowledged,false);
  assert.equal(oauthCount,1);
  state="PENDING";
  assert.equal((await verifier.verify(valid)).verified,false);
  state="PURCHASED";productId="other";
  assert.equal((await verifier.verify(valid)).verified,false);
  productId="blocnote_premium_lifetime";consumption="CONSUMPTION_STATE_CONSUMED";
  assert.equal((await verifier.verify(valid)).verified,false);
  await assert.rejects(()=>verifier.verify({...valid,productId:"rush_premium"}),/invalid_product/);
  await assert.rejects(()=>verifier.verify({...valid,packageName:"com.unknown.app"}),/invalid_product/);
  await assert.rejects(()=>verifier.verify({...valid,purchaseToken:"short"}),/invalid_purchase_token/);
});

test("CHK Paiements : health, achat vérifié, idempotence, remboursement, aucune fuite token",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"chk-google-play-"));
  let current="PURCHASED";
  const fake={
    async ready(){return true;},
    async verify(x){
      assert.equal(x.packageName,valid.packageName);
      assert.equal(x.productId,valid.productId);
      return {
        verified:current==="PURCHASED", state:current,
        tokenHash:hash(x.purchaseToken), packageName:x.packageName,
        productId:x.productId, orderId:"GPA.test.1"
      };
    }
  };
  const {server,hub}=await buildPaymentSidecar({
    host:"127.0.0.1",port:0,
    dataFile:join(dir,"orders.json"),
    devicesFile:join(dir,"devices.json"),
    playVerifier:fake
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const base="http://127.0.0.1:"+server.address().port;
  const health=await fetch(base+"/api/v1/play/health");
  assert.equal(health.status,200);
  assert.equal((await health.json()).billingReady,true);
  const purchase=()=>fetch(base+"/api/v1/play/verify",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify(valid)
  });
  let result=await purchase();
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{
    verified:true,packageName:valid.packageName,productId:valid.productId
  });
  assert.equal((await purchase()).status,200);
  assert.equal(hub.getActivity().length,1);
  assert.equal(hub.getActivity()[0].status,"paid");
  assert.equal(hub.getActivity()[0].currency,"unknown");
  assert.equal(hub.getActivity()[0].amount_cents,null);
  const dump=JSON.stringify(hub.state);
  assert.ok(!dump.includes(token));
  assert.ok(!dump.includes("token_test_google_play"));
  current="CANCELLED";
  result=await purchase();
  assert.equal(result.status,403);
  assert.equal(hub.getActivity().length,1);
  assert.equal(hub.getActivity()[0].status,"refunded");
  assert.equal(hub.getSummary()[0].refunds,1);
  assert.equal((await fetch(base+"/api/v1/activity")).status,401);
});

async function setupRateLimitedPlay(t,limits) {
  const dir=await mkdtemp(join(tmpdir(),"chk-google-play-throttle-"));
  const {server}=await buildPaymentSidecar({
    host:"127.0.0.1",port:0,
    dataFile:join(dir,"orders.json"),devicesFile:join(dir,"devices.json"),
    playVerifier:{
      async ready(){return true;},
      async verify(x){return {
        verified:true,state:"PURCHASED",tokenHash:hash(x.purchaseToken),
        packageName:x.packageName,productId:x.productId,orderId:"GPA.test.limit"
      };}
    },
    ...limits
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const url="http://127.0.0.1:"+server.address().port+"/api/v1/play/verify";
  const verify=(tkn=token,extra={})=>fetch(url,{
    method:"POST",
    headers:{"content-type":"application/json",...extra},
    body:JSON.stringify({...valid,purchaseToken:tkn})
  });
  return {verify,url};
}

test("CHK Paiements stoppe les relectures abusives d'un même jeton",async t=>{
  const {verify}=await setupRateLimitedPlay(t,{playIpRatePerMinute:10,playTokenRatePerMinute:2});
  assert.equal((await verify()).status,200);
  assert.equal((await verify()).status,200);
  const third=await verify();
  assert.equal(third.status,429);
  assert.equal((await third.json()).error,"play_token_rate_limited");
});

test("CHK Paiements limite toutes les requêtes Google Play par connexion",async t=>{
  const {verify}=await setupRateLimitedPlay(t,{playIpRatePerMinute:2,playTokenRatePerMinute:10});
  assert.equal((await verify(token+"A")).status,200);
  assert.equal((await verify(token+"B")).status,200);
  const third=await verify(token+"C",{"x-forwarded-for":"8.8.8.8"});
  assert.equal(third.status,429);
  assert.equal((await third.json()).error,"play_rate_limited");
});

test("CHK Paiements refuse un JSON Play trop volumineux, même sans token valide",async t=>{
  const {url}=await setupRateLimitedPlay(t,{playIpRatePerMinute:10,playTokenRatePerMinute:10});
  const huge={...valid,fill:"X".repeat(9000)};
  const response=await fetch(url,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify(huge)
  });
  assert.equal(response.status,413);
  assert.equal((await response.json()).error,"payload_too_large");
});
