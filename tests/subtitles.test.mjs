import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubtitlesModule,parseSubtitles,exportText } from "../src/subtitles.mjs";
test("SRT and VTT time conversion without invented word timings",()=>{
 const rows=parseSubtitles("1\n00:01:04,000 --> 00:01:07,125\nMon refrain\n\n");
 assert.equal(rows[0].start_ms,64000);assert.equal(rows[0].end_ms,67125);
 assert.match(exportText(rows,"vtt","phrase"),/00:01:04.000 --> 00:01:07.125/);
 assert.throws(()=>exportText(rows,"srt","word"),/no_word_timestamps/);
});
test("isolated connector, revision checks, manual inserts, undo and export",async()=>{
 const root=await mkdtemp(join(tmpdir(),"chk-subs-"));
 try{
 const m=new SubtitlesModule({file:join(root,"core.json"),base:"https://test.invalid"});
 const a={identified:true,enabled:true,app_ids:null,connector_id:"a"},b={...a,connector_id:"b"};
 const p=await m.call("subtitle_create",{title:"test"},a);
 await assert.rejects(()=>m.call("subtitle_project",{project_id:p.project_id},b),/project_not_found/);
 await assert.rejects(()=>m.call("subtitle_list",{}, {...a,app_ids:[]}),/unrestricted/);
 let args={project_id:p.project_id,revision:0,operations:[{action:"add",start_ms:64000,end_ms:68000,text:"Refrain"}]};
 assert.equal((await m.call("subtitle_edit",args,a)).revision,1);
 await assert.rejects(()=>m.call("subtitle_edit",args,a),/revision_conflict/);
 assert.equal((await m.call("subtitle_read",{project_id:p.project_id},a)).items[0].text,"Refrain");
 assert.equal((await m.call("subtitle_undo",{project_id:p.project_id,revision:1},a)).revision,2);
 assert.equal((await m.call("subtitle_read",{project_id:p.project_id},a)).total,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
