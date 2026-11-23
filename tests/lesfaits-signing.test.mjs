import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedLesFaitsClaims, verifyLesFaitsOidc } from "../src/lesfaits-signing.mjs";
import { buildServer } from "../src/server.mjs";

test("Signature LES FAITS : OIDC uniquement dépôt, branche et workflow autorisés", async () => {
  const now=Math.floor(Date.now()/1000);
  const audience="https://chk-universal-1.taild9e4de.ts.net/lesfaits/api/ci/signing";
  const claims={
    repository:"Chasmet/Probl-me-r-curent-travail-",repository_id:"1467654431",
    repository_owner_id:"160381695",actor_id:"160381695",
    ref:"refs/heads/main",
    workflow_ref:"Chasmet/Probl-me-r-curent-travail-/.github/workflows/release.yml@refs/heads/main",
    runner_environment:"github-hosted",event_name:"workflow_dispatch",
    iss:"https://token.actions.githubusercontent.com",aud:audience,
    sub:"repo:Chasmet/Probl-me-r-curent-travail-:ref:refs/heads/main",
    iat:now-5,nbf:now-5,exp:now+120
  };
  assert.equal(allowedLesFaitsClaims(claims,audience,now),true);
  for (const [k,v] of [
    ["repository","Chasmet/Camera-maison"],["ref","refs/heads/dev"],
    ["workflow_ref","Chasmet/Probl-me-r-curent-travail-/.github/workflows/android.yml@refs/heads/main"],
    ["event_name","pull_request"],["aud","https://evil.invalid"],
    ["runner_environment","self-hosted"],["actor_id","other"],["exp",now-60]
  ]) assert.equal(allowedLesFaitsClaims({...claims,[k]:v},audience,now),false,k);
  assert.equal(await verifyLesFaitsOidc("not-a-jwt",audience),false);
});

test("Signature LES FAITS : route privée et anciens chemins opérationnels",async t=>{
  const folder=await mkdtemp(join(tmpdir(),"lesfaits-signing-test-"));
  const config={host:"127.0.0.1",port:0,base:"http://localhost:8787",
    adminPassword:"test-long-password-2026",jwtSecret:"x".repeat(64),
    file:join(folder,"data.json"),lesfaitsToken:"",lesfaitsConnectorIds:"",legacyUrl:"",ollamaUrl:""};
  const {server}=await buildServer(config);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(folder,{force:true,recursive:true});});
  const base="http://127.0.0.1:"+server.address().port;
  assert.equal((await fetch(base+"/lesfaits/api/ci/signing")).status,401);
  assert.equal((await fetch(base+"/lesfaits/api/ci/signing",{headers:{authorization:"Bearer invalid"}})).status,403);
  assert.equal((await fetch(base+"/lesfaits/api/ci/signing",{method:"POST"})).status,405);
  assert.equal((await fetch(base+"/camera/api/health")).status,200);
  assert.equal((await fetch(base+"/xdebt/api/health")).status,200);
  assert.equal((await fetch(base+"/health")).status,200);
});
