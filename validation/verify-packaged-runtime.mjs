import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = resolve(process.argv[2]);
const { buildServer } = await import(pathToFileURL(join(runtime, 'src/server.mjs')));
const dir = await mkdtemp(join(tmpdir(), 'chk-packaged-'));
const app = await buildServer({host:'127.0.0.1',port:0,base:'http://localhost:8787',
  adminPassword:'packaged-smoke-test-password',jwtSecret:'j'.repeat(64),
  file:join(dir,'server.json'),ollamaUrl:'',legacyUrl:''});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+app.server.address().port;
try {
  const manifest=await import('node:fs/promises').then(fs=>fs.readFile(join(runtime,'package.json'),'utf8')).then(JSON.parse);
  const health=await (await fetch(url+'/health')).json();
  assert.equal(health.version,manifest.version);
  assert.equal(health.browser_protocol,2);
  const worker=await app.store.registerApp({name:'CHK Agent Browser Android · Local 3',
    capabilities:[{name:'browser_status',readOnly:true}]});
  const login=await (await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({password:'packaged-smoke-test-password'})})).json();
  const call=async name=>(await (await fetch(url+'/mcp',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+login.access_token},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name}})})).json()).result;
  const list=await call('apps_list');
  assert.ok(list.structuredContent && !Array.isArray(list.structuredContent));
  assert.ok(list.structuredContent.apps.some(a=>a.id===worker.id));
  assert.ok(!JSON.stringify(list).includes(worker.secret));
  assert.equal((await call('server_status')).structuredContent.version,manifest.version);
  const identity=await call('connector_identity');assert.equal(identity.structuredContent.identified,false);
  assert.equal((await call('chk_read')).structuredContent.legacy_required,false);
  console.log('PACKAGED_LOCAL3_OK: version '+manifest.version+', apps_list object, connector identity, direct Android diagnostics');
} finally {
  await new Promise(r=>app.server.close(r));
  await rm(dir,{recursive:true,force:true});
}
