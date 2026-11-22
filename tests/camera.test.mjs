import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { allowedCameraClaims, verifyCameraOidc } from "../src/camera.mjs";
const aud="https://chk-universal-1.taild9e4de.ts.net/camera/api/ci/signing";
const now=Math.floor(Date.now()/1000);
const good={
  repository:"Chasmet/Camera-maison",repository_id:"1467502821",
  repository_owner_id:"160381695",actor_id:"160381695",
  ref:"refs/heads/main",workflow_ref:"Chasmet/Camera-maison/.github/workflows/build.yml@refs/heads/main",
  runner_environment:"github-hosted",event_name:"push",
  sub:"repo:Chasmet/Camera-maison:ref:refs/heads/main",
  iss:"https://token.actions.githubusercontent.com",aud,exp:now+250,nbf:now-10,iat:now-10
};
test("Camera signing only allows the owner's GitHub main workflow",()=>{
  assert.ok(allowedCameraClaims(good,aud));
  for(const [name,value] of Object.entries({
    repository:"Chasmet/Coran",repository_id:"123",repository_owner_id:"123",
    actor_id:"999",ref:"refs/heads/test",
    workflow_ref:"Chasmet/Camera-maison/.github/workflows/evil.yml@refs/heads/main",
    runner_environment:"self-hosted",event_name:"pull_request",
    sub:"repo:Chasmet/Camera-maison:pull_request",aud:"https://evil.invalid",
    iss:"https://evil.invalid",exp:now-500
  })) assert.equal(allowedCameraClaims({...good,[name]:value},aud),false,name);
});
test("OIDC verifies signature and refuses forged tokens",async()=>{
  const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  const header=Buffer.from(JSON.stringify({alg:"RS256",kid:"test"})).toString("base64url");
  const payload=Buffer.from(JSON.stringify(good)).toString("base64url");
  const data=header+"."+payload;
  const signature=sign("RSA-SHA256",Buffer.from(data),privateKey).toString("base64url");
  const provider=async()=>[{...publicKey.export({format:"jwk"}),kid:"test",alg:"RS256"}];
  assert.equal(await verifyCameraOidc(data+"."+signature,aud,provider),true);
  assert.equal(await verifyCameraOidc(data+"."+signature.slice(0,-3)+"BAD",aud,provider),false);
  assert.equal(await verifyCameraOidc(data+"."+signature,"https://wrong.invalid",provider),false);
});
