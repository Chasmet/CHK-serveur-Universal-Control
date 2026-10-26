import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { buildServer } from '../src/server.mjs';
import { Store, hash } from '../src/core.mjs';
import { createSecurity } from '../src/security.mjs';

async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'chk-connectors-'));
 const config={host:'127.0.0.1',port:0,base:'http://localhost:8787',adminPassword:'connector-test-password',jwtSecret:'c'.repeat(64),file:join(dir,'state.json'),ollamaUrl:'',legacyUrl:''};
 const {server,store}=await buildServer(config);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 const req=async(path,{token,body,method=body?'POST':'GET',redirect='follow'}={})=>{
  const response=await fetch(base+path,{method,redirect,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  return response;
 };
 const owner=(await (await req('/api/login',{body:{password:config.adminPassword}})).json()).access_token;
 const rpc=async(token,name,args={},method='tools/call')=>{
  const response=await req('/mcp',{token,body:{jsonrpc:'2.0',id:1,method,params:method==='tools/call'?{name,arguments:args}:{}}});
  return {status:response.status,body:await response.json()};
 };
 return {dir,config,store,req,owner,rpc};
}
async function oauth(ctx,name,existingClient=null){
 const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
 const client=existingClient || await (await ctx.req('/oauth/register',{body:{client_name:name,redirect_uris:[redirect]}})).json();
 const verifier=randomBytes(40).toString('base64url');
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirect,code_challenge_method:'S256',code_challenge:challenge,resource:ctx.config.base+'/mcp'});
 const approved=await ctx.req('/oauth/authorize?'+query,{body:{password:ctx.config.adminPassword},redirect:'manual'});
 assert.equal(approved.status,302);
 const code=new URL(approved.headers.get('location')).searchParams.get('code');
 const grant=await (await ctx.req('/oauth/token',{body:{grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:redirect,resource:ctx.config.base+'/mcp',code_verifier:verifier}})).json();
 return {...client,...grant};
}
test('separate OAuth connectors retain their identity, routing, permissions and task deduplication',async t=>{
 const ctx=await setup(t);
 const appA=await ctx.store.registerApp({name:'Browser',capabilities:[{name:'inspect',readOnly:true}]});
 const appB=await ctx.store.registerApp({name:'Another application',capabilities:[{name:'inspect',readOnly:true}]});
 const a=await oauth(ctx,'ChatGPT');const b=await oauth(ctx,'ChatGPT');
 assert.notEqual(a.client_id,b.client_id);assert.notEqual(a.access_token,b.access_token);
 const shared=await oauth(ctx,'ChatGPT',a);assert.equal(shared.client_id,a.client_id);assert.notEqual(shared.connector_id,a.connector_id);assert.notEqual(shared.access_token,a.access_token);
 for(const [client,app] of [[a,appA],[b,appB]]){
  const response=await ctx.req('/api/connectors/'+client.connector_id,{token:ctx.owner,method:'PUT',body:{name:app.name,app_ids:[app.id]}});
  assert.equal(response.status,200);
  const identity=(await ctx.rpc(client.access_token,'connector_identity')).body.result.structuredContent;
  assert.equal(identity.client_id,client.client_id);assert.equal(identity.connector_id,client.connector_id);assert.deepEqual(identity.app_ids,[app.id]);assert.equal(identity.name,app.name);
  const visible=(await ctx.rpc(client.access_token,'apps_list')).body.result.structuredContent;
  assert.deepEqual(visible.apps.map(a=>a.id),[app.id]);
  const tools=(await ctx.rpc(client.access_token,'',{},'tools/list')).body.result.tools.map(t=>t.name);
  assert.ok(!tools.includes('godot_run'));assert.ok(!tools.includes('crypto_portfolio'));assert.ok(tools.includes('connector_identity'));
 }
 const taskA=(await ctx.rpc(a.access_token,'task_submit',{action:'inspect',request_id:'same-request'})).body.result.structuredContent;
 const taskB=(await ctx.rpc(b.access_token,'task_submit',{action:'inspect',request_id:'same-request'})).body.result.structuredContent;
 assert.notEqual(taskA.id,taskB.id);assert.equal(taskA.connector_id,a.connector_id);assert.equal(taskB.connector_id,b.connector_id);
 assert.equal((await ctx.rpc(a.access_token,'task_submit',{action:'inspect',request_id:'same-request'})).body.result.structuredContent.id,taskA.id);
 assert.equal((await ctx.rpc(a.access_token,'task_submit',{action:'inspect',args:{different:true},request_id:'same-request'})).body.result.isError,true);
 assert.equal((await ctx.rpc(a.access_token,'task_submit',{app_id:appB.id,action:'inspect'})).body.result.isError,true);
 assert.equal((await ctx.rpc(a.access_token,'task_get',{task_id:taskB.id})).body.result.structuredContent.error,'task_not_found');
 assert.equal((await ctx.req('/api/apps',{token:a.access_token})).status,403);
 assert.equal((await ctx.req('/api/connectors/'+a.connector_id,{token:a.access_token,method:'PUT',body:{app_ids:null}})).status,403);
 await ctx.req('/api/connectors/'+a.connector_id,{token:ctx.owner,method:'PUT',body:{enabled:false}});
 assert.equal((await ctx.rpc(a.access_token,'connector_identity')).status,401);
 assert.equal((await ctx.rpc(b.access_token,'connector_identity')).status,200);
 assert.equal((await ctx.rpc(shared.access_token,'connector_identity')).status,200);
 const renewed=await (await ctx.req('/oauth/token',{body:{grant_type:'refresh_token',client_id:shared.client_id,refresh_token:shared.refresh_token,resource:ctx.config.base+'/mcp'}})).json();
 assert.equal(renewed.connector_id,shared.connector_id);
 assert.equal((await ctx.rpc(renewed.access_token,'connector_identity')).body.result.structuredContent.connector_id,shared.connector_id);
 const refresh=await ctx.req('/oauth/token',{body:{grant_type:'refresh_token',client_id:a.client_id,refresh_token:a.refresh_token,resource:ctx.config.base+'/mcp'}});
 assert.equal(refresh.status,400);
 const restored=await new Store(ctx.config.file).init();
 assert.deepEqual(restored.state.connectors[a.connector_id].app_ids,[appA.id]);assert.equal(restored.appAuthorized(appA.id,appA.secret),true);
});
test('10,000 connector and application records remain searchable, paged and individually addressable after reload',async t=>{
 const ctx=await setup(t);const started=performance.now();
 await ctx.store.change(state=>{
  for(let i=0;i<10000;i++){
   const suffix=i.toString(16).padStart(36,'0');const id='chk_'+suffix;
   state.apps[suffix]={id:suffix,name:'Application '+i,capabilities:[{name:'inspect',readOnly:true}],secret_hash:hash('worker-'+i),registered_at:i,last_seen:null};
   state.connectors['conn_'+suffix]={client_id:id,client_name:'Connecteur '+i,enabled:true,app_ids:[suffix],created_at:i};
   state.clients[id]={client_name:'Connecteur '+i,redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect'],enabled:true,app_ids:[suffix],created_at:i};
  }
 });
 const restored=await new Store(ctx.config.file).init();const security=createSecurity(ctx.config,restored);
 assert.equal(restored.connectorsPage({offset:9975,limit:25}).connectors.length,25);
 assert.equal(restored.connectorsPage({offset:9975,limit:25}).next_offset,null);
 assert.equal(restored.connectorsPage({query:'Connecteur 9999'}).connectors[0].name,'Connecteur 9999');
 for(const i of [0,4999,9999]){
  const suffix=i.toString(16).padStart(36,'0');const id='chk_'+suffix;
  const token=security.token('owner','mcp:read mcp:write',id,'conn_'+suffix);
  assert.equal(security.identity(token).client_id,id);
  assert.equal(restored.appsPage({},security.identity(token).app_ids).apps[0].id,suffix);
 }
 const newClient=await (await ctx.req('/oauth/register',{body:{client_name:'Connecteur 10001',redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']}})).json();
 assert.ok(newClient.client_id);
 
 const page=(await ctx.rpc(ctx.owner,'apps_list',{offset:10000,limit:100,include_capabilities:false})).body.result.structuredContent;
 assert.equal(page.apps.length,1);assert.equal(page.next_offset,null);assert.ok(!('capabilities' in page.apps[0]));
 await ctx.store.change(state=>{
  for(let i=10000;i<21000;i++){
   const suffix=i.toString(16).padStart(36,'0');
   state.apps[suffix]={id:suffix,name:'Application '+i,capabilities:[{name:'inspect',readOnly:true}],secret_hash:hash('worker-'+i),registered_at:i,last_seen:null};
   state.connectors['conn_'+suffix]={client_id:'chk_'+suffix,client_name:'Connecteur '+i,enabled:true,app_ids:[suffix],created_at:i};
   state.clients['chk_'+suffix]={client_name:'Connecteur '+i,redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect'],created_at:i};
  }
 });
 const extra=await (await ctx.req('/oauth/register',{body:{client_name:'Beyond old cap',redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']}})).json();assert.ok(extra.client_id);
 assert.ok((await ctx.store.registerApp({name:'Beyond old app cap',capabilities:[{name:'inspect',readOnly:true}]})).id);
 assert.equal(ctx.store.connectorsPage().max_registered,null);
 console.log('REGISTRY_10000_OK: distinct identities, lookup, pagination, persistence; elapsed_ms='+Math.round(performance.now()-started));
});

test('public OAuth registration throttles a burst without imposing a lifetime connector cap',async t=>{
 const ctx=await setup(t);
 for(let i=0;i<30;i++)assert.equal((await ctx.req('/oauth/register',{body:{client_name:'Test '+i,redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']}})).status,201);
 const response=await ctx.req('/oauth/register',{body:{client_name:'Retry later',redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']}});
 assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');
 assert.equal(ctx.store.connectorsPage().max_registered,null);
});

test('new application types may add capabilities through their own authenticated worker without server code changes',async t=>{
 const ctx=await setup(t);
 const app=await ctx.store.registerApp({name:'A future application',capabilities:[{name:'inspect',readOnly:true},{name:'edit',readOnly:false}]});
 const route='/api/agent/'+app.id+'/capabilities';
 const payload={capabilities:[{name:'new_reader',readOnly:true},{name:'new_writer',readOnly:false}]};
 assert.equal((await ctx.req(route,{method:'PUT',token:'bad',body:payload})).status,401);
 assert.equal((await ctx.req(route,{method:'PUT',token:app.secret,body:payload})).status,200);
 assert.equal((await ctx.store.submit({app_id:app.id,action:'new_reader'})).state,'queued');
 assert.equal((await ctx.store.submit({app_id:app.id,action:'new_writer'})).state,'pending_approval');
 assert.equal((await ctx.req(route,{method:'PUT',token:app.secret,body:{capabilities:[{name:'edit',readOnly:true}]}})).status,400);
});


test('OAuth migration and new authorizations preserve client application restrictions',async t=>{
 const ctx=await setup(t);
 const app=await ctx.store.registerApp({name:'Allowed app',capabilities:[{name:'inspect',readOnly:true}]});
 const other=await ctx.store.registerApp({name:'Other app',capabilities:[{name:'inspect',readOnly:true}]});
 const first=await oauth(ctx,'Legacy restricted client');
 await ctx.req('/api/connectors/'+first.client_id,{token:ctx.owner,method:'PUT',body:{app_ids:[app.id]}});
 const fresh=await oauth(ctx,'Same client',first);
 const identity=(await ctx.rpc(fresh.access_token,'connector_identity')).body.result.structuredContent;
 assert.deepEqual(identity.app_ids,[app.id]);
 // Old refresh grants had no connectorId before version 1.0.2.
 const legacyRefresh='legacy-refresh-for-migration';
 await ctx.store.change(s=>{s.refresh[hash(legacyRefresh)]={clientId:first.client_id,requestedScope:'mcp:read mcp:write',expires:Date.now()+60000};});
 const migrated=await (await ctx.req('/oauth/token',{body:{grant_type:'refresh_token',client_id:first.client_id,refresh_token:legacyRefresh,resource:ctx.config.base+'/mcp'}})).json();
 assert.ok(migrated.connector_id);
 assert.deepEqual((await ctx.rpc(migrated.access_token,'apps_list')).body.result.structuredContent.apps.map(a=>a.id),[app.id]);
 assert.equal((await ctx.rpc(migrated.access_token,'task_submit',{app_id:other.id,action:'inspect'})).body.result.isError,true);
 // A connection cannot enlarge its OAuth client's allowed applications.
 await ctx.req('/api/connectors/'+fresh.connector_id,{token:ctx.owner,method:'PUT',body:{app_ids:null}});
 assert.deepEqual((await ctx.rpc(fresh.access_token,'connector_identity')).body.result.structuredContent.app_ids,[app.id]);
 await ctx.req('/api/connectors/'+first.client_id,{token:ctx.owner,method:'PUT',body:{app_ids:[]}});
 assert.deepEqual((await ctx.rpc(fresh.access_token,'apps_list')).body.result.structuredContent.apps,[]);
});

test('specialized visual and Crypto commands retain connector ownership and separate identical request IDs',async t=>{
 const ctx=await setup(t);
 const app=await ctx.store.registerApp({name:'CHK Crypto Analyse 2',capabilities:[
  {name:'ui_status',readOnly:true},{name:'ui_capture',readOnly:true},{name:'ui_tap',readOnly:false},
  {name:'crypto_portfolio',readOnly:true},{name:'crypto_chart_control',readOnly:false}
 ]});
 await ctx.store.registerApp({name:'CHK Crypto Android',capabilities:[{name:'crypto_portfolio',readOnly:true},{name:'crypto_chart_control',readOnly:false}]});
 const a=await oauth(ctx,'Same display name');const b=await oauth(ctx,'Same display name',a);
 const visualA=(await ctx.rpc(a.access_token,'crypto_action',{action:'ui_tap',args:{x:10,y:20},request_id:'same-visual-id'})).body.result.structuredContent;
 const visualB=(await ctx.rpc(b.access_token,'crypto_action',{action:'ui_tap',args:{x:10,y:20},request_id:'same-visual-id'})).body.result.structuredContent;
 assert.ok(visualA.id);assert.ok(visualB.id);assert.notEqual(visualA.id,visualB.id);
 assert.equal(visualA.connector_id,a.connector_id);assert.equal(visualB.connector_id,b.connector_id);
 assert.equal((await ctx.rpc(a.access_token,'crypto_action',{action:'ui_tap',args:{x:10,y:20},request_id:'same-visual-id'})).body.result.structuredContent.id,visualA.id);
 assert.equal((await ctx.rpc(b.access_token,'crypto_result',{task_id:visualA.id})).body.result.structuredContent.error,'task_not_found');
 assert.equal((await ctx.rpc(a.access_token,'crypto_result',{task_id:visualA.id})).body.result.structuredContent.id,visualA.id);
 const portfolio=(await ctx.rpc(a.access_token,'crypto_portfolio')).body.result.structuredContent;
 assert.ok(portfolio.task_id);assert.equal(ctx.store.getJob(portfolio.task_id).connector_id,a.connector_id);
 assert.equal((await ctx.rpc(b.access_token,'crypto_task_result',{task_id:portfolio.task_id})).body.result.structuredContent.error,'crypto_task_not_found');
 assert.equal((await ctx.rpc(a.access_token,'crypto_task_result',{task_id:portfolio.task_id})).body.result.structuredContent.task_id,portfolio.task_id);
 const chart=(await ctx.rpc(b.access_token,'crypto_chart_control',{action:'zoom_in'})).body.result.structuredContent;
 assert.equal(ctx.store.getJob(chart.task_id).connector_id,b.connector_id);
 assert.equal(ctx.store.getJob(chart.task_id).state,'pending_approval');
 assert.equal((await ctx.rpc(ctx.owner,'task_get',{task_id:portfolio.task_id})).body.result.structuredContent.id,portfolio.task_id);
});

test('Local 3 persistent Android consent removes repeated approvals, survives reload, and revokes queued effects',async t=>{
 const ctx=await setup(t);
 const caps=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../src/browser-capabilities.json',import.meta.url),'utf8'));
 const app=await ctx.store.registerApp({name:'CHK Agent Browser Android · Local 3',capabilities:caps});
 const generic=await ctx.store.registerApp({name:'Other app',capabilities:[{name:'write',readOnly:false}]});
 const a=await oauth(ctx,'Local 3');const b=await oauth(ctx,'Other Browser connector');
 const send=(token,name,args)=>ctx.rpc(token,name,{app_id:app.id,...args});
 const before=(await send(a.access_token,'browser_navigate',{url:'https://example.org',request_id:'navigation'})).body.result.structuredContent;
 assert.equal(before.state,'pending_approval');
 assert.equal((await send(a.access_token,'permissions_grant',{})).body.result.structuredContent.error,'device_authorization_required');
 const route='/api/agent/'+app.id+'/permissions';
 assert.equal((await ctx.req(route,{method:'PUT',token:a.access_token,body:{enabled:true}})).status,401);
 assert.equal((await ctx.req('/api/agent/'+generic.id+'/permissions',{method:'PUT',token:generic.secret,body:{enabled:true}})).status,400);
 assert.equal((await ctx.req(route,{method:'PUT',token:app.secret,body:{enabled:true,version:'test'}})).status,200);
 assert.equal(ctx.store.getJob(before.id).state,'pending_approval'); // Do not execute a stale request just because the APK was upgraded.
 await send(a.access_token,'permissions_grant',{resume_pending:true});
 assert.equal(ctx.store.getJob(before.id).state,'queued');assert.equal(ctx.store.getJob(before.id).authorization,'persistent');
 const next=(await send(a.access_token,'browser_type',{selector:'#prompt',text:'A prompt'})).body.result.structuredContent;
 assert.equal(next.state,'queued');assert.equal(next.authorization,'persistent');
 assert.equal((await ctx.rpc(a.access_token,'task_submit',{app_id:generic.id,action:'write'})).body.result.structuredContent.state,'pending_approval');
 let restored=await new Store(ctx.config.file).init();
 const {permitted}=await import('../src/autonomy.mjs');
 assert.equal(permitted(restored.state,restored.state.apps[app.id],'browser_type',a.connector_id),true);
 await send(a.access_token,'permissions_revoke',{});
 assert.equal(ctx.store.getJob(before.id).state,'pending_approval');assert.equal(ctx.store.getJob(next.id).state,'pending_approval');
 assert.equal((await send(b.access_token,'browser_navigate',{url:'https://example.org'})).body.result.structuredContent.state,'queued');
 await send(a.access_token,'permissions_grant',{actions:['browser_open_url'],resume_pending:true});
 assert.equal(ctx.store.getJob(before.id).state,'queued');assert.equal(ctx.store.getJob(next.id).state,'pending_approval');
 const perms=(await ctx.rpc(a.access_token,'permissions_list')).body.result.structuredContent;
 assert.deepEqual(perms.permissions[0].automatic_actions,['browser_open_url']);assert.equal(perms.request_quota,null);
 await ctx.req(route,{method:'PUT',token:app.secret,body:{enabled:false}});
 assert.equal(ctx.store.getJob(before.id).state,'pending_approval');
 const after=(await send(b.access_token,'browser_navigate',{url:'https://example.org'})).body.result.structuredContent;
 assert.equal(after.state,'pending_approval');
 restored=await new Store(ctx.config.file).init();assert.equal(restored.state.apps[app.id].autonomy.enabled,false);
 const log=(await ctx.rpc(a.access_token,'activity_list',{limit:2})).body.result.structuredContent;
 assert.equal(log.activity.length,2);assert.ok(log.next_offset);assert.ok(log.activity.every(j=>j.connector_id===a.connector_id&&!('args' in j)));
});

test('Local 3 upload and durable workflow tools route to real registered Android handlers and preserve job truth',async t=>{
 const ctx=await setup(t);const caps=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../src/browser-capabilities.json',import.meta.url),'utf8'));
 const app=await ctx.store.registerApp({name:'CHK Agent Browser Android · Local 3',capabilities:caps});const a=await oauth(ctx,'Browser');
 await ctx.req('/api/agent/'+app.id+'/permissions',{method:'PUT',token:app.secret,body:{enabled:true}});
 await ctx.req('/api/connectors/'+a.connector_id,{token:ctx.owner,method:'PUT',body:{app_ids:[app.id]}});
 const tools=(await ctx.rpc(a.access_token,'',{},'tools/list')).body.result.tools.map(t=>t.name);
 for(const name of ['permissions_list','permissions_grant','permissions_revoke','browser_navigate','browser_upload_file','browser_screenshot','task_run','task_status','task_resume','activity_list'])assert.ok(tools.includes(name),name);
 const upload=(await ctx.rpc(a.access_token,'browser_upload_file',{id:'upload-1',expected_host:'grok.com',selector:'input[type=file]',files:[{workspace_path:'image.png'}]})).body.result.structuredContent;
 assert.equal(upload.action,'browser_upload_file');assert.equal(upload.state,'queued');assert.equal(upload.result,null);
 const run=(await ctx.rpc(a.access_token,'task_run',{id:'cuts',steps:[{id:'inspect',action:'read_page',args:{}}]})).body.result.structuredContent;
 assert.equal(run.action,'workflow_run');assert.equal(run.state,'queued');
 const b=await oauth(ctx,'Other workflow connection',a);
 const other=(await ctx.rpc(b.access_token,'task_run',{id:'cuts',steps:[{id:'inspect',action:'read_page',args:{}}]})).body.result.structuredContent;
 assert.notEqual(run.args.id,other.args.id);
 const resumed=(await ctx.rpc(a.access_token,'task_resume',{id:'cuts'})).body.result.structuredContent;assert.equal(resumed.args.id,run.args.id);
 assert.equal((await ctx.rpc(a.access_token,'task_status',{id:'cuts'})).body.result.structuredContent.action,'workflow_status');
 assert.equal((await ctx.rpc(a.access_token,'task_resume',{id:'cuts'})).body.result.structuredContent.action,'workflow_resume');
 assert.equal((await ctx.rpc(a.access_token,'task_cancel',{workflow_id:'cuts'})).body.result.structuredContent.action,'workflow_cancel');
 const first=await ctx.store.poll(app.id);assert.equal(first.id,upload.id);
 const restored=await new Store(ctx.config.file).init();assert.equal(restored.getJob(first.id).state,'unknown');
 const recovered=await restored.result(app.id,first.id,{ok:false,execution_state:'unknown',retry_command:false});
 assert.equal(recovered.state,'failed');assert.equal(recovered.result.retry_command,false);
 const polled=await restored.poll(app.id);assert.notEqual(polled.id,first.id);
});
