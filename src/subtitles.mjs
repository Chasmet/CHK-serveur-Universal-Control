import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat, readdir, appendFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const prefix="/subtitles/api";
const maxMedia=500*1024*1024;
const safeId=s=>typeof s==="string"&&/^[a-f0-9]{24}$/.test(s);
const hash=s=>createHash("sha256").update(s).digest("hex");
const id=()=>randomBytes(12).toString("hex");
const ticketId=()=>randomBytes(32).toString("hex");
const num=(x,min,max)=>{if(!Number.isSafeInteger(x)||x<min||x>max)throw Error("invalid_time_or_offset");return x;};
const str=(x,max=4000)=>{if(typeof x!=="string"||x.length>max)throw Error("invalid_text");return x;};
const prop=(type,extra={})=>({type,...extra});
const P=prop("string"), I=prop("integer"), B=prop("boolean");
const tool=(name,description,properties={},required=[],readOnlyHint=true)=>({name,title:name.replaceAll("_"," "),description,inputSchema:{type:"object",properties,required,additionalProperties:false},readOnlyHint});
const project={project_id:P};
const range={...project,start_ms:I,end_ms:I};
export const subtitleTools=[
 tool("subtitle_status","État du module local, dépendances et traitements actifs."),
 tool("subtitle_create","Créer un projet privé et un lien d'import audio dans CHK Browser. Aucun fichier n'est envoyé sans sélection.",{title:P},["title"],false),
 tool("subtitle_list","Lister les projets privés de cette connexion."),
 tool("subtitle_project","Lire état, durée, révision et nombre de passages du projet.",project,["project_id"]),
 tool("subtitle_open","Ouvrir le lecteur/éditeur sécurisé dans le navigateur personnel : audio, forme d'onde, clavier et correction.",project,["project_id"],false),
 tool("subtitle_read","Lire les phrases ou mots horodatés par pages, sans pavé.",{...project,offset:I,limit:I,mode:prop("string",{enum:["phrase","word"]})},["project_id"]),
 tool("subtitle_setup","Installer dans un environnement Python privé les moteurs libres faster-whisper et éventuellement WhisperX. Premier téléchargement sur le PC.",{alignment:B},[],false),
 tool("subtitle_transcribe","Transcrire l'audio local avec vrais horodatages de mots; option de plage ciblée. Résultat en brouillon, ne remplace pas les corrections.",{...range,model:prop("string",{enum:["large-v3","turbo","medium","small"]}),language:P,vad:B},["project_id"],false),
 tool("subtitle_align","Réaligner les paroles existantes par WhisperX sur l'audio, à partir de leurs fenêtres temporelles. Nécessite le moteur d'alignement.",project,["project_id"],false),
 tool("subtitle_job","Lire progression, diagnostic et résultat du dernier traitement.",project,["project_id"]),
 tool("subtitle_cancel","Annuler le traitement en cours sans modifier les paroles enregistrées.",project,["project_id"],false),
 tool("subtitle_candidate","Lire le brouillon automatique avant validation.",{...project,offset:I,limit:I},["project_id"]),
 tool("subtitle_apply","Appliquer le brouillon automatique à la révision attendue; sauvegarde précédente conservée.",{...project,revision:I},["project_id","revision"],false),
 tool("subtitle_edit","Éditer un lot de passages à la révision attendue. Actions add, replace, remove, shift. Les horaires sont en millisecondes.",{...project,revision:I,operations:prop("array",{maxItems:100,items:{type:"object",properties:{action:prop("string",{enum:["add","replace","remove","shift"]}),index:I,start_ms:I,end_ms:I,text:P,delta_ms:I},required:["action"]}})},["project_id","revision","operations"],false),
 tool("subtitle_import","Importer des sous-titres SRT ou VTT existants; conserver une sauvegarde.",{...project,revision:I,text:P},["project_id","revision","text"],false),
 tool("subtitle_undo","Restaurer la précédente version des paroles, à la révision attendue.",{...project,revision:I},["project_id","revision"],false),
 tool("subtitle_waveform","Lire les amplitudes réelles de l’audio après son analyse, pour repérer les silences et les attaques.",project,["project_id"]),
 tool("subtitle_word_edit","Corriger le texte ou les horaires d’un mot dans une phrase, ajouter ou supprimer un mot. Aucune estimation fictive.",{...project,revision:I,phrase_index:I,word_index:I,action:prop("string",{enum:["add","replace","remove"]}),start_ms:I,end_ms:I,text:P},["project_id","revision","phrase_index","action"],false),
 tool("subtitle_audit","Vérifier chevauchements, trous, passages longs et mots non horodatés.",project,["project_id"]),
 tool("subtitle_export","Préparer les sous-titres SRT, VTT, TXT ou JSON (mots ou phrases) et un lien privé de téléchargement.",{...project,format:prop("string",{enum:["srt","vtt","txt","json"]}),mode:prop("string",{enum:["word","phrase"]})},["project_id","format"],false),
 tool("subtitle_listen","Ouvrir le lecteur audio sur un passage précis. Retourne aussi les paroles horodatées de la plage; ne prétend pas transmettre une écoute brute au modèle ChatGPT.",range,["project_id","start_ms","end_ms"],false)
];

function stamp(ms,comma=false){let h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;return [h,m,s].map(x=>String(x).padStart(2,"0")).join(":")+(comma?",":".")+String(ms%1000).padStart(3,"0");}
function parseTime(s){let m=/^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})$/.exec(s.trim());if(!m)throw Error("invalid_subtitle_timestamp");return num((Number(m[1]||0)*3600+Number(m[2])*60+Number(m[3]))*1000+Number(m[4]),0,86400000);}
export function parseSubtitles(value){
 const lines=str(value,90000).replace(/^\uFEFF/,"").replace(/\r/g,"").split("\n");
 const out=[];for(let i=0;i<lines.length;i++){
  if(!lines[i].includes("-->"))continue;
  const [a,b]=lines[i].split("-->");const start=parseTime(a),end=parseTime(b.trim().split(/\s+/)[0]);let words=[];
  while(i+1<lines.length&&lines[i+1].trim()&&!lines[i+1].includes("-->"))words.push(lines[++i]);
  if(words.length)out.push(cleanRow({start_ms:start,end_ms:end,text:words.join("\n")}));
 }if(!out.length)throw Error("no_subtitles_found");return out.sort((a,b)=>a.start_ms-b.start_ms);
}
function cleanRow(r,duration=86400000){
 const start_ms=num(r.start_ms,0,duration),end_ms=num(r.end_ms,start_ms+1,duration),text=str(r.text,8000).trim();
 if(!text)throw Error("empty_subtitle");
 const words=Array.isArray(r.words)?r.words.slice(0,500).filter(w=>Number.isSafeInteger(w.start_ms)&&Number.isSafeInteger(w.end_ms)&&w.start_ms>=start_ms&&w.end_ms<=end_ms&&w.end_ms>w.start_ms&&typeof w.text==="string").map(w=>({start_ms:w.start_ms,end_ms:w.end_ms,text:w.text.slice(0,250),...(typeof w.confidence==="number"?{confidence:w.confidence}:{})})):[]; 
 return {start_ms,end_ms,text,words};
}
function flatten(rows,mode){return mode==="word"?rows.flatMap(r=>r.words||[]):rows;}
export function exportText(rows,format,mode){
 const items=flatten(rows,mode);
 if(mode==="word"&&!items.length)throw Error("no_word_timestamps_available");
 if(format==="json")return JSON.stringify(items,null,2);
 if(format==="txt")return items.map(r=>r.text).join("\n");
 const cues=items.map((r,i)=>(format==="srt"?(i+1)+"\n":"")+stamp(r.start_ms,format==="srt")+" --> "+stamp(r.end_ms,format==="srt")+"\n"+r.text.replace(/-->/g,"→")+"\n").join("\n");
 return format==="vtt"?"WEBVTT\n\n"+cues:cues;
}
async function jsonFile(path,otherwise){try{return JSON.parse(await readFile(path,"utf8"));}catch(e){if(e.code==="ENOENT")return otherwise;throw e;}}
async function atomic(path,value){const tmp=path+"."+id()+".tmp";try{await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,path);}finally{await rm(tmp,{force:true}).catch(()=>{});}}
async function exists(path){try{return (await stat(path)).isFile();}catch{return false;}}
export class SubtitlesModule {
 constructor(config={}){
  this.base=config.base||"http://localhost:8787";
  this.root=join(dirname(config.file),"subtitles");
  this.tickets=new Map();this.running=new Map();this.locks=new Set();this.setup=null;
  this.python=process.env.CHK_SUBTITLE_PYTHON||"python";
  this.worker=fileURLToPath(new URL("./subtitle-worker.py",import.meta.url));
  this.envDir=join(this.root,"python-env");
 }
 owner(identity){if(!identity?.identified||identity.enabled===false||identity.app_ids!==null)throw Error("subtitle_requires_unrestricted_owner_connector");return hash(identity.connector_id);}
 async folder(owner,projectId){if(!safeId(projectId))throw Error("invalid_project_id");return join(this.root,owner,projectId);}
 async load(owner,projectId){const dir=await this.folder(owner,projectId),meta=await jsonFile(join(dir,"project.json"),null);if(!meta)throw Error("project_not_found");return {dir,meta};}
 async rows(dir){return await jsonFile(join(dir,"lyrics.json"),[]);}
 async pythonExe(){const path=process.platform==="win32"?join(this.envDir,"Scripts","python.exe"):join(this.envDir,"bin","python");return await exists(path)?path:this.python;}
 issue(owner,projectId){const now=Date.now();for(const [k,v] of this.tickets)if(v.expires<now)this.tickets.delete(k);if(this.tickets.size>=200)throw Error("too_many_open_sessions");const ticket=ticketId();this.tickets.set(ticket,{owner,projectId,expires:now+30*60*1000});return ticket;}
 link(owner,projectId,extra=""){return this.base+prefix+"/editor#"+this.issue(owner,projectId)+extra;}
 async withLock(dir,fn){if(this.locks.has(dir))throw Error("project_busy");this.locks.add(dir);try{return await fn();}finally{this.locks.delete(dir);}}
 async saveRows(dir,meta,rows,revision){
  if(meta.revision!==revision)throw Error("revision_conflict_reload_project");
  if(!Array.isArray(rows)||rows.length>10000)throw Error("invalid_or_too_many_subtitles");
  const duration=meta.duration_ms||86400000;
  if(!Array.isArray(rows))throw Error("invalid_rows");
  rows=rows.map(r=>cleanRow(r,duration)).sort((a,b)=>a.start_ms-b.start_ms);
  await atomic(join(dir,"previous.json"),await this.rows(dir));await atomic(join(dir,"lyrics.json"),rows);
  meta.revision++;await atomic(join(dir,"project.json"),meta);return {ok:true,revision:meta.revision,phrases:rows.length,words:flatten(rows,"word").length};
 }
 page(rows,a){const offset=num(a.offset??0,0,100000),limit=num(a.limit??40,1,100);return {total:rows.length,offset,items:rows.slice(offset,offset+limit),next_offset:offset+limit<rows.length?offset+limit:null};}
 async inspect(dir,meta){const rows=await this.rows(dir);return {...meta,phrases:rows.length,words:flatten(rows,"word").length};}
 async setupStatus(){
  const py=await this.pythonExe();
  return await new Promise(resolve=>{let child;try{child=spawn(py,["-c","import importlib.util,json; print(json.dumps({'faster_whisper':importlib.util.find_spec('faster_whisper') is not None,'whisperx':importlib.util.find_spec('whisperx') is not None}))"],{windowsHide:true,stdio:["ignore","pipe","ignore"]});}catch{return resolve({python:false});}
   let out="";child.stdout.on("data",d=>{if(out.length<2000)out+=d;});const timer=setTimeout(()=>{child.kill();resolve({python:false,reason:"timeout"});},5000);
   child.on("error",()=>{clearTimeout(timer);resolve({python:false});});child.on("close",code=>{clearTimeout(timer);try{resolve({python:code===0,...JSON.parse(out)});}catch{resolve({python:false});}});
  });
 }
 async runCommand(exe,args,job){return await new Promise((resolve,reject)=>{const child=spawn(exe,args,{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,PYTHONUNBUFFERED:"1"}});job.child=child;let tail="";const add=d=>{tail=(tail+d.toString()).slice(-2500);job.message=tail;};child.stdout.on("data",add);child.stderr.on("data",add);child.on("error",reject);child.on("close",code=>code===0?resolve():reject(Error("process_exit_"+code+" "+tail.slice(-500))));});}
 async install(alignment){
  if(this.setup?.state==="running"||this.running.size)throw Error("engine_busy");
  const job={state:"running",message:"Préparation Python"};this.setup=job;
  void (async()=>{try{await mkdir(this.root,{recursive:true});let py=await this.pythonExe();if(py===this.python){await this.runCommand(py,["-m","venv",this.envDir],job);py=await this.pythonExe();}
    await this.runCommand(py,["-m","pip","install","--disable-pip-version-check","faster-whisper==1.2.1",...(alignment?["whisperx==3.4.2"]:[])],job);job.state="completed";job.message="Installation terminée";
   }catch(e){job.state="failed";job.message=String(e.message).slice(0,600);}finally{delete job.child;}})();
  return {state:job.state};
 }
 async job(dir){const info=this.running.get(dir);if(info)return {state:info.state,progress:info.progress,message:info.message};const old=await jsonFile(join(dir,"job.json"),{state:"idle"});return old.state==="running"?{...old,state:"interrupted"}:old;}
 async start(dir,meta,args,mode){
  if(!meta.media)throw Error("upload_audio_first");
  if(this.running.size||this.setup?.state==="running")throw Error("engine_busy");
  const status=await this.setupStatus();if(!status.faster_whisper||(mode==="align"&&!status.whisperx))throw Error("local_engine_not_installed_use_subtitle_setup");
  const start=num(args.start_ms??0,0,86400000),end=args.end_ms==null?null:num(args.end_ms,start+1,86400000);
  if(mode==="align"&&!(await this.rows(dir)).length)throw Error("import_or_transcribe_lyrics_first");
  const model=["large-v3","turbo","medium","small"].includes(args.model)?args.model:"large-v3";
  const language=args.language||"fr";if(!/^[a-z]{2,3}$/.test(language))throw Error("invalid_language");
  const config={mode,model,language,vad:args.vad===true,start_ms:start,end_ms:end,media:join(dir,meta.media),waveform:join(dir,"waveform.json"),input:join(dir,"lyrics.json"),output:join(dir,"candidate.json")};
  await atomic(join(dir,"worker-config.json"),config);
  await rm(join(dir,"candidate.json"),{force:true});
  const job={state:"running",progress:0,message:"Chargement du moteur local",revision:meta.revision};this.running.set(dir,job);await atomic(join(dir,"job.json"),{state:"running",revision:meta.revision});
  const py=await this.pythonExe();
  void (async()=>{try{
    const child=spawn(py,["-u",this.worker,join(dir,"worker-config.json")],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,PYTHONUNBUFFERED:"1"}});job.child=child;
    let pending="";child.stdout.on("data",d=>{pending+=d.toString();let ix;while((ix=pending.indexOf("\n"))>=0){let line=pending.slice(0,ix);pending=pending.slice(ix+1);try{const j=JSON.parse(line);job.progress=j.progress??job.progress;job.message=String(j.message||"").slice(0,200);}catch{}}if(pending.length>10000)pending="";});
    let err="";child.stderr.on("data",d=>{err=(err+d.toString()).slice(-1200);});
    await new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",code=>code===0?resolve():reject(Error("worker_exit_"+code+" "+err.slice(-400))));});
    if(job.cancelled)throw Error("cancelled");const candidate=await jsonFile(join(dir,"candidate.json"),null);if(!candidate||!Array.isArray(candidate.rows)||!candidate.rows.length)throw Error("no_lyrics_detected");
    job.state="completed";job.progress=100;job.message="Brouillon disponible";job.phrases=candidate.rows.length;
  }catch(e){job.state=job.cancelled?"cancelled":"failed";job.message=String(e.message).slice(0,600);}
  finally{delete job.child;await atomic(join(dir,"job.json"),job).catch(()=>{});this.running.delete(dir);}})();
  return {state:"running",revision:meta.revision};
 }
 async call(name,a,identity){
  const owner=this.owner(identity);
  if(name==="subtitle_status"){const engine=await this.setupStatus();return {service:"CHK Sous-titres",local:true,engine,setup:this.setup?{state:this.setup.state,message:this.setup.message?.slice(-500)}:null,running:this.running.size};}
  if(name==="subtitle_setup")return this.install(a.alignment===true);
  if(name==="subtitle_create"){
   const project_id=id(),dir=await this.folder(owner,project_id);await mkdir(dir,{recursive:true,mode:0o700});
   const meta={project_id,title:str(a.title,180).trim()||"Morceau",revision:0,duration_ms:null,media:null,created_at:Date.now()};
   await atomic(join(dir,"project.json"),meta);await atomic(join(dir,"lyrics.json"),[]);
   return {...meta,editor_url:this.link(owner,project_id)};
  }
  if(name==="subtitle_list"){const folder=join(this.root,owner);let ids;try{ids=await readdir(folder);}catch(e){if(e.code==="ENOENT")return {items:[]};throw e;}const items=[];for(const x of ids.filter(safeId)){const m=await jsonFile(join(folder,x,"project.json"),null);if(m)items.push(m);}return {items:items.sort((a,b)=>b.created_at-a.created_at)};}
  const {dir,meta}=await this.load(owner,a.project_id);
  if(name==="subtitle_project")return this.inspect(dir,meta);
  if(name==="subtitle_open")return {editor_url:this.link(owner,a.project_id)};
  if(name==="subtitle_read")return this.page(flatten(await this.rows(dir),a.mode),a);
  if(name==="subtitle_waveform"){const data=await jsonFile(join(dir,"waveform.json"),null);return data||{available:false,reason:"Lance une transcription ou un alignement pour calculer la forme d’onde."};}
  if(name==="subtitle_job")return this.job(dir);
  if(name==="subtitle_candidate"){const c=await jsonFile(join(dir,"candidate.json"),null);if(!c)throw Error("no_candidate");return {...this.page(c.rows,a),duration_ms:c.duration_ms,method:c.method};}
  if(name==="subtitle_transcribe"||name==="subtitle_align")return this.withLock(dir,()=>this.start(dir,meta,a,name==="subtitle_align"?"align":"transcribe"));
  if(name==="subtitle_cancel"){const j=this.running.get(dir);if(!j)return {state:"not_running"};j.cancelled=true;j.child?.kill();return {state:"cancelling"};}
  if(name==="subtitle_listen"){const start=num(a.start_ms,0,86400000),end=num(a.end_ms,start+1,86400000);return {editor_url:this.link(owner,a.project_id,"&start="+start+"&end="+end),start_ms:start,end_ms:end,passages:(await this.rows(dir)).filter(r=>r.start_ms<end&&r.end_ms>start).slice(0,20),audio_preview:"Lecture dans CHK Browser, pas d'écoute brute dans le chat."};}
  if(name==="subtitle_audit"){const rows=await this.rows(dir),issues=[];let last=0;for(let i=0;i<rows.length;i++){const r=rows[i];if(r.start_ms<last)issues.push({index:i,type:"overlap",ms:last-r.start_ms});if(r.start_ms-last>4000)issues.push({index:i,type:"gap_review",ms:r.start_ms-last});if(r.end_ms-r.start_ms>10000)issues.push({index:i,type:"long_phrase"});if(!r.words?.length)issues.push({index:i,type:"no_word_timing"});
   else {const expected=r.text.trim().split(/\s+/).filter(Boolean).length;if(r.words.length<expected)issues.push({index:i,type:"incomplete_word_timing",timed:r.words.length,expected});const low=r.words.filter(w=>typeof w.confidence==="number"&&w.confidence<0.45).length;if(low)issues.push({index:i,type:"low_confidence_words",count:low});}last=Math.max(last,r.end_ms);}return {count:issues.length,issues:issues.slice(0,100),note:"Un silence ou une instrumentale n'est pas nécessairement une erreur."};}
  if(name==="subtitle_export"){if(!["srt","vtt","txt","json"].includes(a.format))throw Error("invalid_format");const text=exportText(await this.rows(dir),a.format,a.mode);const t=this.issue(owner,a.project_id);return {download_url:this.base+prefix+"/download?ticket="+t+"&format="+a.format+"&mode="+(a.mode==="word"?"word":"phrase"),bytes:Buffer.byteLength(text),format:a.format};}
  if(["subtitle_edit","subtitle_import","subtitle_apply","subtitle_undo","subtitle_word_edit"].includes(name)){
   return this.withLock(dir,async()=>{
    const latest=(await this.load(owner,a.project_id)).meta;let rows=await this.rows(dir);
    if(name==="subtitle_import")rows=parseSubtitles(a.text);
    if(name==="subtitle_undo")rows=await jsonFile(join(dir,"previous.json"),null)??rows;
    if(name==="subtitle_apply"){
     const candidate=await jsonFile(join(dir,"candidate.json"),null),j=await this.job(dir);if(!candidate||j.state!=="completed"||j.revision!==latest.revision)throw Error("candidate_missing_or_stale");
     latest.duration_ms=candidate.duration_ms||latest.duration_ms;
     rows=candidate.range?rows.filter(r=>r.end_ms<=candidate.range[0]||r.start_ms>=candidate.range[1]).concat(candidate.rows):candidate.rows;
    }
    if(name==="subtitle_word_edit"){
     const phrase=rows[num(a.phrase_index,0,rows.length-1)],words=phrase.words||[];
     if(a.action==="remove"){words.splice(num(a.word_index,0,words.length-1),1);}
     else if(a.action==="add"||a.action==="replace"){
      const old=a.action==="replace"?words[num(a.word_index,0,words.length-1)]:{};
      const start_ms=num(a.start_ms??old.start_ms,phrase.start_ms,phrase.end_ms-1);
      const end_ms=num(a.end_ms??old.end_ms,start_ms+1,phrase.end_ms);
      const text=str(a.text??old.text,250).trim();if(!text)throw Error("empty_word");
      const word={start_ms,end_ms,text};
      if(a.action==="add")words.push(word);else words[a.word_index]=word;
     }else throw Error("invalid_word_edit");
     phrase.words=words.sort((a,b)=>a.start_ms-b.start_ms);
     // Preserve phrase text; user can correct it independently if needed.
    }
    if(name==="subtitle_edit"){
     if(!Array.isArray(a.operations)||a.operations.length<1||a.operations.length>100)throw Error("invalid_operations");
     for(const op of a.operations){
      if(op.action==="add")rows.push(cleanRow(op));
      else if(op.action==="shift"){const delta=num(op.delta_ms,-86400000,86400000);const targets=op.index==null?rows:[rows[num(op.index,0,rows.length-1)]];for(const r of targets){r.start_ms+=delta;r.end_ms+=delta;for(const w of r.words||[]){w.start_ms+=delta;w.end_ms+=delta;}}}
      else {const i=num(op.index,0,rows.length-1);if(op.action==="remove")rows.splice(i,1);else if(op.action==="replace")rows[i]=cleanRow({...rows[i],...op,words:[]});else throw Error("invalid_edit");}
     }
    }
    return this.saveRows(dir,latest,rows,a.revision);
   });
  }
  throw Error("unknown_subtitle_tool");
 }
 async handle(req,res,url,body,json){
  const action=url.pathname.slice(prefix.length);
  if(req.method==="GET"&&(action==="/editor"||action==="/editor.js")){
   res.writeHead(200,{"content-type":action.endsWith(".js")?"text/javascript; charset=utf-8":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});
   return res.end(await readFile(fileURLToPath(new URL(action.endsWith(".js")?"../public/subtitles.js":"../public/subtitles.html",import.meta.url))));
  }
  const t=req.headers["x-subtitle-ticket"]||url.searchParams.get("ticket");const session=this.tickets.get(t);
  if(!session||session.expires<Date.now())return json(res,401,{error:"expired_or_invalid_subtitle_session"});
  const {dir,meta}=await this.load(session.owner,session.projectId);
  if(req.method==="GET"&&action==="/state")return json(res,200,{project:await this.inspect(dir,meta),rows:await this.rows(dir),job:await this.job(dir),waveform:await jsonFile(join(dir,"waveform.json"),null)});
  if(req.method==="POST"&&action==="/upload")return this.withLock(dir,async()=>{
   if(this.running.has(dir)||meta.media)throw Error("media_already_present_or_busy");
   const size=num(body.size,1,maxMedia),offset=num(body.offset,0,size),ext=extname(str(body.filename,255)).toLowerCase();
   if(![".mp3",".wav",".m4a",".aac",".flac",".ogg",".opus",".mp4",".webm",".mov"].includes(ext))throw Error("unsupported_media");
   const part=join(dir,"upload.part"),upload=await jsonFile(join(dir,"upload.json"),null);
   if(!upload){if(offset!==0)throw Error("upload_offset");await atomic(join(dir,"upload.json"),{size,ext});}
   else if(upload.size!==size||upload.ext!==ext)throw Error("upload_mismatch");
   if(typeof body.data!=="string"||body.data.length>1400000||!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data))throw Error("invalid_upload_chunk");
   const buffer=Buffer.from(body.data,"base64");const length=await exists(part)?(await stat(part)).size:0;
   if(length!==offset||!buffer.length||offset+buffer.length>size)throw Error("upload_offset");
   await appendFile(part,buffer,{mode:0o600});
   if(offset+buffer.length===size){meta.media="original"+ext;await rename(part,join(dir,meta.media));await atomic(join(dir,"project.json"),meta);await rm(join(dir,"upload.json"),{force:true});}
   return json(res,200,{received:offset+buffer.length,complete:Boolean(meta.media)});
  });
  if(req.method==="POST"&&action==="/upload-reset")return this.withLock(dir,async()=>{if(meta.media||this.running.has(dir))throw Error("media_already_present_or_busy");await rm(join(dir,"upload.part"),{force:true});await rm(join(dir,"upload.json"),{force:true});return json(res,200,{ok:true});});
  if(req.method==="POST"&&action==="/edit")return this.withLock(dir,async()=>{const latest=(await this.load(session.owner,session.projectId)).meta;return json(res,200,await this.saveRows(dir,latest,body.rows,body.revision));});
  if(req.method==="POST"&&action==="/import")return this.withLock(dir,async()=>json(res,200,await this.saveRows(dir,(await this.load(session.owner,session.projectId)).meta,parseSubtitles(body.text),body.revision)));
  if(req.method==="GET"&&action==="/download"){const format=url.searchParams.get("format");if(!["srt","vtt","txt","json"].includes(format))throw Error("invalid_format");const content=exportText(await this.rows(dir),format,url.searchParams.get("mode"));res.writeHead(200,{"content-type":"application/octet-stream","content-disposition":"attachment; filename=\"subtitles."+format+"\"","cache-control":"no-store"});return res.end(content);}
  if(req.method==="GET"&&action==="/media"&&meta.media){
   const path=join(dir,meta.media),size=(await stat(path)).size;const mime={".mp3":"audio/mpeg",".wav":"audio/wav",".m4a":"audio/mp4",".aac":"audio/aac",".ogg":"audio/ogg",".opus":"audio/ogg",".flac":"audio/flac",".mp4":"video/mp4",".webm":"video/webm",".mov":"video/quicktime"}[extname(path)]||"application/octet-stream";
   let start=0,end=size-1,status=200;const r=req.headers.range;if(r){const m=/^bytes=(\d+)-(\d*)$/.exec(r);if(!m)return json(res,416,{error:"invalid_range"});start=Number(m[1]);end=m[2]?Math.min(end,Number(m[2])):end;if(start>end||start<0||start>=size)return json(res,416,{error:"invalid_range"});status=206;}
   res.writeHead(status,{"content-type":mime,"content-length":end-start+1,"accept-ranges":"bytes","cache-control":"no-store",...(status===206?{"content-range":"bytes "+start+"-"+end+"/"+size}:{})});const stream=createReadStream(path,{start,end});stream.on("error",()=>res.destroy());res.on("close",()=>stream.destroy());return stream.pipe(res);
  }
  return json(res,404,{error:"subtitle_route_not_found"});
 }
}
