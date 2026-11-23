import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server.mjs";

test("LES FAITS: OAuth mobile PKCE sans jeton statique, et lecture MCP ChatGPT autorisée", async t => {
  const dir=await mkdtemp(join(tmpdir(),"lesfaits-oauth-"));
  const config={host:"127.0.0.1",port:0,base:"http://localhost:8787",adminPassword:"top-secret-test-password-2026",
    jwtSecret:"z".repeat(64),file:join(dir,"universal.json"),lesfaitsToken:"",lesfaitsConnectorIds:"",ollamaUrl:"",legacyUrl:""};
  const {server}=await buildServer(config);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const base="http://127.0.0.1:"+server.address().port;
  const send=async(path,body,ctype="application/json")=>fetch(base+path,{
    method:"POST",headers:{"content-type":ctype},body:ctype==="application/json"?JSON.stringify(body):new URLSearchParams(body)
  });
  const redirect_uri="fr.sync30.lesfaits://oauth/callback";
  const registered=await send("/oauth/register",{client_name:"LES FAITS — SYNC 30",redirect_uris:[redirect_uri],token_endpoint_auth_method:"none"});
  assert.equal(registered.status,201);
  const client_id=(await registered.json()).client_id;
  const code_verifier=randomBytes(40).toString("base64url");
  const code_challenge=createHash("sha256").update(code_verifier).digest("base64url");
  const resource=config.base+"/mcp";
  const query=new URLSearchParams({response_type:"code",client_id,redirect_uri,resource,code_challenge,code_challenge_method:"S256",scope:"mcp:write",state:"testStateMobile"});
  assert.equal((await fetch(base+"/oauth/authorize?"+query)).status,200);
  const approved=await fetch(base+"/oauth/authorize?"+query,{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({password:config.adminPassword}),redirect:"manual"
  });
  assert.equal(approved.status,302);
  const callback=new URL(approved.headers.get("location"));
  assert.equal(callback.origin,"null");
  assert.equal(callback.searchParams.get("iss"),config.base);
  assert.equal(callback.searchParams.get("state"),"testStateMobile");
  const exchanged=await send("/oauth/token",{grant_type:"authorization_code",client_id,
    redirect_uri,resource,code_verifier,code:callback.searchParams.get("code")},"application/x-www-form-urlencoded");
  assert.equal(exchanged.status,200);
  const token=await exchanged.json();
  assert.ok(token.access_token);
  const payload={deviceId:"12345678-1234-1234-1234-123456789abc",incidents:[{id:1,title:"Fait daté",description:"Sans jeton statique",space:"TERRAIN",recurring:true}]};
  const upload=await fetch(base+"/lesfaits/api/incidents",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token.access_token},
    body:JSON.stringify(payload)});
  assert.equal(upload.status,200);
  const noAuth=await fetch(base+"/lesfaits/api/incidents");
  assert.equal(noAuth.status,401);
  // A connector approved through ChatGPT's OAuth may read reports; anonymous clients cannot.
  const chatUri="https://chatgpt.com/connector_platform_oauth_redirect";
  const chat=await send("/oauth/register",{client_name:"ChatGPT",redirect_uris:[chatUri]});
  assert.equal(chat.status,201);
  const chatId=(await chat.json()).client_id;
  const chatVerifier=randomBytes(40).toString("base64url");
  const chatChallenge=createHash("sha256").update(chatVerifier).digest("base64url");
  const chatQuery=new URLSearchParams({response_type:"code",client_id:chatId,redirect_uri:chatUri,resource,
    code_challenge_method:"S256",code_challenge:chatChallenge,scope:"mcp:read",state:"test"});
  const chatApprove=await fetch(base+"/oauth/authorize?"+chatQuery,{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({password:config.adminPassword}),redirect:"manual"
  });
  assert.equal(chatApprove.status,302);
  const code=new URL(chatApprove.headers.get("location")).searchParams.get("code");
  const chatTokens=await send("/oauth/token",{grant_type:"authorization_code",client_id:chatId,
    redirect_uri:chatUri,resource,code_verifier:chatVerifier,code},"application/x-www-form-urlencoded");
  assert.equal(chatTokens.status,200);
  const chatAccess=(await chatTokens.json()).access_token;
  const call=async(method,params={})=>(await (await fetch(base+"/mcp",{method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer "+chatAccess},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})})).json()).result;
  const tools=await call("tools/list");
  assert.ok(tools.tools.some(t=>t.name==="lesfaits_list"));
  const res=await call("tools/call",{name:"lesfaits_list",arguments:{}});
  assert.equal(res.structuredContent.items[0].title,"Fait daté");
});
