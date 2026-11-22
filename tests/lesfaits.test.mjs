import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.mjs";
const token="test-32-char-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

test("LES FAITS: route isolée et MCP invisible par défaut", async t => {
  const dir=await mkdtemp(join(tmpdir(),"lesfaits-test-"));
  const cfg={host:"127.0.0.1",port:0,base:"http://localhost:8787",
    adminPassword:"secure-test-password-2026",jwtSecret:"x".repeat(64),
    file:join(dir,"server.json"),lesfaitsToken:token,lesfaitsConnectorIds:"",ollamaUrl:"",legacyUrl:""};
  const {server}=await buildServer(cfg);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{force:true,recursive:true});});
  const url="http://127.0.0.1:"+server.address().port;
  assert.equal((await fetch(url+"/health")).status,200);
  assert.equal((await fetch(url+"/lesfaits/api/health")).status,200);
  assert.equal((await fetch(url+"/lesfaits/api/incidents",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
  const payload={deviceId:"12345678-1234-1234-1234-123456789abc",incidents:[{id:17,space:"TERRAIN",title:"Panne équipement",description:"Constat enregistré",location:"Atelier",recurring:true,occurred:1763800000000,notes:[{at:1763800000000,text:"Signalement inscrit"}]}]};
  const posted=await fetch(url+"/lesfaits/api/incidents",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(payload)});
  assert.equal(posted.status,200);
  assert.equal((await posted.json()).count,1);
  const listed=await fetch(url+"/lesfaits/api/incidents",{headers:{authorization:"Bearer "+token}});
  assert.equal((await listed.json()).items[0].title,"Panne équipement");
  const login=await fetch(url+"/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:cfg.adminPassword})});
  const {access_token}=await login.json();
  const rpc=await fetch(url+"/mcp",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+access_token},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
  assert.equal((await rpc.json()).result.tools.some(x=>x.name==="lesfaits_list"),false);
  assert.equal((await fetch(url+"/camera/api/health")).status,200);
  assert.equal((await fetch(url+"/xdebt/api/health")).status,200);
});
