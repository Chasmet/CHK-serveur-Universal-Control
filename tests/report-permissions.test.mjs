import test from 'node:test';
import assert from 'node:assert/strict';
import { permitted, ownerReportPermission, ownerReportPermissionView } from '../src/autonomy.mjs';
const setup=()=>{
 const app={id:'a',name:'LES FAITS — SYNC 30',capabilities:[{name:'lesfaits_create',readOnly:false},{name:'lesfaits_attach',readOnly:false},{name:'lesfaits_detach',readOnly:false},{name:'delete_report',readOnly:false}]};
 const state={apps:{a:app,b:{...app,id:'b'}},connectors:{c:{client_id:'client'},d:{client_id:'client'}},clients:{client:{enabled:true}},jobs:{j:{app_id:'a',connector_id:'c',action:'lesfaits_create',state:'pending_approval'},k:{app_id:'a',connector_id:'d',action:'lesfaits_create',state:'pending_approval'},l:{app_id:'a',connector_id:'c',action:'delete_report',state:'pending_approval'}}};
 return {state,change:async fn=>fn(state)};
};
test('owner consent is explicit, scoped, revocable and never grants delete',async()=>{
 const store=setup(),s=store.state,a=s.apps.a;
 assert.equal(permitted(s,a,'lesfaits_create','c'),false);
 await ownerReportPermission(store,'a','c',{enabled:true,resume_pending:true});
 assert.equal(permitted(s,a,'lesfaits_create','c'),true);
 assert.equal(permitted(s,a,'lesfaits_attach','c'),true);
 assert.equal(permitted(s,a,'lesfaits_detach','c'),true);
 assert.equal(permitted(s,a,'delete_report','c'),false);
 assert.equal(permitted(s,a,'lesfaits_create','d'),false);
 assert.equal(permitted(s,s.apps.b,'lesfaits_create','c'),false);
 assert.equal(permitted(s,a,'lesfaits_create',null),false);
 assert.equal(s.jobs.j.state,'queued');assert.equal(s.jobs.k.state,'pending_approval');assert.equal(s.jobs.l.state,'pending_approval');
 assert.equal(ownerReportPermissionView(store).apps[0].connectors[0].grant.enabled,true);
 s.connectors.c.enabled=false;assert.equal(permitted(s,a,'lesfaits_create','c'),false);
 s.connectors.c.enabled=true;
 await ownerReportPermission(store,'a','c',{enabled:false});
 assert.equal(s.jobs.j.state,'pending_approval');assert.equal(permitted(s,a,'lesfaits_create','c'),false);
 s.connectors.c.app_ids=['b'];
 await assert.rejects(ownerReportPermission(store,'a','c',{enabled:true}),/invalid_report_connector_scope/);
});

test('new reversible report capabilities require consent, while permanent deletion remains blocked',async()=>{
 const store=setup(),s=store.state,a=s.apps.a;
 const actions=['lesfaits_modifier','lesfaits_merge','lesfaits_archive','lesfaits_restore'];
 a.capabilities.push(...actions.map(name=>({name,readOnly:false})),{name:'lesfaits_delete',readOnly:false});
 s.connectors.c.automatic_operations=true;
 for(const action of actions)assert.equal(permitted(s,a,action,'c'),false);
 await ownerReportPermission(store,'a','c',{enabled:true});
 for(const action of actions){
  assert.equal(permitted(s,a,action,'c'),true);
  assert.equal(permitted(s,a,action,'d'),false);
 }
 assert.equal(permitted(s,a,'lesfaits_delete','c'),false);
 await ownerReportPermission(store,'a','c',{enabled:false});
 for(const action of actions)assert.equal(permitted(s,a,action,'c'),false);
});
