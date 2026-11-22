import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LESFAITS_PREFIX = "/lesfaits/api";
export const lesfaitsTools = [
  { name:"lesfaits_list",title:"LES FAITS — signalements",description:"Lire les signalements synchronisés sur le serveur personnel LES FAITS (accès explicite uniquement).",readOnlyHint:true,
    inputSchema:{type:"object",properties:{espace:{type:"string",enum:["TOUT","TERRAIN","PERSONNEL"]},recurrents:{type:"boolean"},limit:{type:"integer",minimum:1,maximum:100}}} },
  { name:"lesfaits_detail",title:"LES FAITS — dossier",description:"Consulter un dossier précis avec les observations, selon l'identifiant et l'appareil.",readOnlyHint:true,
    inputSchema:{type:"object",required:["deviceId","id"],properties:{deviceId:{type:"string"},id:{type:"integer",minimum:1}}} },
  { name:"lesfaits_stats",title:"LES FAITS — statistiques",description:"Statistiques des problèmes et récurrences enregistrées.",readOnlyHint:true,
    inputSchema:{type:"object",properties:{}} }
];
const MAX_RECORDS=10000;
const limitText=(v,max)=>String(v??"").slice(0,max);
const num=v=>Number.isFinite(Number(v))?Number(v):0;

export class LesFaitsModule {
  constructor(config={}) {
    this.secret=config.lesfaitsToken || process.env.LESFAITS_TOKEN || "";
    this.allow=new Set(String(config.lesfaitsConnectorIds || process.env.LESFAITS_CONNECTOR_IDS || "").split(",").map(s=>s.trim()).filter(Boolean));
    this.file=join(dirname(config.file),"lesfaits.json");
  }
  enabled(){return this.secret.length>=24;}
  allowedConnector(id){return this.enabled() && Boolean(id) && this.allow.has(id);}
  authorize(req) {
    const token=/^Bearer ([A-Za-z0-9._-]+)$/i.exec(req.headers.authorization||"")?.[1]||"";
    if(!this.enabled()||token.length!==this.secret.length)return false;
    return timingSafeEqual(Buffer.from(token),Buffer.from(this.secret));
  }
  async read(){
    try {
      const state=JSON.parse(await readFile(this.file,"utf8"));
      return state && typeof state==="object" && !Array.isArray(state) ? state : {};
    }catch(e){if(e.code==="ENOENT")return {};throw e;}
  }
  clean(body){
    if(!body || !Array.isArray(body.incidents)||body.incidents.length>MAX_RECORDS)throw Error("invalid_lesfaits_payload");
    const deviceId=limitText(body.deviceId,70);
    if(!/^[a-zA-Z0-9-]{12,70}$/.test(deviceId))throw Error("invalid_lesfaits_device");
    const incidents=body.incidents.map(i=>{
      if(!i || !Number.isSafeInteger(i.id)||i.id<1)throw Error("invalid_lesfaits_id");
      return {
        id:i.id,
        space:i.space==="PERSONNEL"?"PERSONNEL":"TERRAIN",
        category:limitText(i.category,200),title:limitText(i.title,500),
        description:limitText(i.description,15000),location:limitText(i.location,1000),
        occurred:num(i.occurred),created:num(i.created),
        severity:limitText(i.severity,50),status:limitText(i.status,50),
        recurring:Boolean(i.recurring),
        notes:Array.isArray(i.notes)?i.notes.slice(0,1000).map(n=>({at:num(n.at),text:limitText(n.text,5000)})):[]
      };
    });
    return {deviceId,incidents,exportedAt:Date.now()};
  }
  async save(body){
    const data=this.clean(body),state=await this.read();
    state[data.deviceId]={incidents:data.incidents,exportedAt:data.exportedAt};
    await mkdir(dirname(this.file),{recursive:true,mode:0o700});
    const tmp=this.file+"."+randomBytes(6).toString("hex")+".tmp";
    try {await writeFile(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,this.file);}
    finally {await rm(tmp,{force:true}).catch(()=>{});}
    return {ok:true,count:data.incidents.length};
  }
  async list(a={}){
    const state=await this.read();
    const all=Object.entries(state).flatMap(([deviceId,value])=>(value.incidents||[]).map(i=>({...i,deviceId})));
    const space=["TERRAIN","PERSONNEL"].includes(a.espace)?a.espace:"TOUT";
    const cap=Math.min(100,Math.max(1,Number(a.limit)||50));
    const filtered=all.filter(i=>(space==="TOUT"||i.space===space)&&(!a.recurrents||i.recurring)).sort((x,y)=>y.occurred-x.occurred);
    return {total:filtered.length,items:filtered.slice(0,cap)};
  }
  async detail(a={}){
    const all=(await this.list({limit:100})).items;
    // Access the entire snapshot rather than the paginated list for a direct lookup.
    const state=await this.read();
    const target=(state[a.deviceId]?.incidents||[]).find(i=>i.id===a.id);
    return target?{...target,deviceId:a.deviceId}:{error:"lesfaits_not_found"};
  }
  async stats(){
    const data=await this.read();const all=Object.values(data).flatMap(x=>x.incidents||[]);
    const status={};
    for(const i of all)status[i.status]=(status[i.status]||0)+1;
    return {total:all.length,recurrents:all.filter(i=>i.recurring).length,parStatut:status};
  }
  async handle(req,res,url,body,json){
    const suffix=url.pathname.slice(LESFAITS_PREFIX.length);
    if(suffix==="/health" && req.method==="GET")return json(res,200,{service:"LES FAITS",enabled:this.enabled(),version:"0.1.0"});
    if(!this.enabled())return json(res,503,{error:"lesfaits_not_configured"});
    if(!this.authorize(req))return json(res,401,{error:"lesfaits_auth_required"});
    if(suffix==="/incidents" && req.method==="GET")return json(res,200,await this.list({limit:100}));
    if(suffix==="/incidents" && req.method==="POST"){
      try {return json(res,200,await this.save(body));}
      catch(e){return json(res,400,{error:"invalid_lesfaits_payload"});}
    }
    return json(res,404,{error:"lesfaits_not_found"});
  }
}
