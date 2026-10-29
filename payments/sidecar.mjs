import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PaymentsHub, verifyStripeSignature } from "./hub.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const compare = (a,b) => {
  if (typeof a !== "string" || typeof b !== "string" || !/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));
};
const safeName = name => String(name ?? "").trim().slice(0,64);
const result = (res,status,object) => {
  res.writeHead(status, { "content-type":"application/json; charset=utf-8", "cache-control":"no-store",
    "x-content-type-options":"nosniff", "x-frame-options":"DENY", "referrer-policy":"no-referrer" });
  res.end(JSON.stringify(object));
};
const readRaw = async (req, limit=262144) => {
  let chunks=[],size=0;
  for await (const part of req) {size+=part.length; if(size>limit) throw Error("body_too_large"); chunks.push(part);}
  return Buffer.concat(chunks);
};
const readJson = async req => {
  if(!String(req.headers["content-type"]||"").includes("application/json")) throw Error("json_required");
  return JSON.parse((await readRaw(req)).toString("utf8"));
};

export class DeviceRegistry {
  constructor(file) { this.file=file; this.queue=Promise.resolve(); }
  async read() {
    try {
      const state=JSON.parse(await readFile(this.file,"utf8"));
      if(state.schema!==1 || !Array.isArray(state.devices)) throw Error("devices_data_corrupt");
      return state;
    } catch(e) { if(e.code==="ENOENT") return {schema:1,devices:[],pair_code_hash:null,pair_expires:0}; throw e; }
  }
  async write(state) {
    await mkdir(dirname(this.file),{recursive:true,mode:0o700});
    const temp=this.file+"."+randomBytes(6).toString("hex")+".tmp";
    await writeFile(temp,JSON.stringify(state),{mode:0o600});
    await rename(temp,this.file);
  }
  serialize(fn) {
    const task=this.queue.then(async()=>fn(await this.read()));
    this.queue=task.catch(()=>{});
    return task;
  }
  async generateCode() {
    return this.serialize(async state=>{
      const code=randomBytes(24).toString("hex");
      state.pair_code_hash=sha(code);
      state.pair_expires=Date.now()+10*60000;
      await this.write(state);
      return code;
    });
  }
  async pair(code,device_name) {
    return this.serialize(async state=>{
      if(!/^[a-f0-9]{48}$/.test(code||"") || Date.now()>state.pair_expires ||
          !compare(sha(code),state.pair_code_hash)) throw Error("invalid_or_expired_pair_code");
      const device_token="chkpay_"+randomBytes(32).toString("base64url");
      const device_id="payphone_"+randomBytes(12).toString("hex");
      state.devices.push({id:device_id,name:safeName(device_name)||"Android CHK Paiements",
        token_hash:sha(device_token),active:true,registered_at:Date.now()});
      state.pair_code_hash=null;state.pair_expires=0;
      await this.write(state);
      return {device_token,device_id};
    });
  }
  async authorize(token) {
    if(!token?.startsWith("chkpay_")) return null;
    const digest=sha(token);
    const state=await this.read();
    return state.devices.find(d=>d.active && compare(d.token_hash,digest))||null;
  }
  async revoke(deviceId) {
    return this.serialize(async state=>{
      const device=state.devices.find(d=>d.id===deviceId);
      if(!device) throw Error("device_missing");
      device.active=false;
      await this.write(state);
    });
  }
}

export async function buildPaymentSidecar(opts={}) {
  const config={
    port:Number(process.env.PAYMENTS_PORT||8791),
    host:"127.0.0.1", // NEVER bind publicly directly
    dataFile:process.env.PAYMENTS_DATA_FILE||"./data/payments-orders.json",
    devicesFile:process.env.PAYMENTS_DEVICES_FILE||"./data/payment-devices.json",
    webhookSecret:process.env.STRIPE_PAYMENTS_WEBHOOK_SECRET||"",
    mcpReadToken:process.env.PAYMENTS_MCP_READ_TOKEN||"",
    ...opts
  };
  if(config.host!=="127.0.0.1" && config.host!=="::1") throw Error("loopback_only");
  const hub=await new PaymentsHub(config.dataFile).init();
  const devices=new DeviceRegistry(config.devicesFile);
  const fails=new Map();
  const mcpTools=[
    {name:"payments_status",description:"État de CHK Paiements et volumes, sans données bancaires",inputSchema:{type:"object",properties:{}}},
    {name:"payments_activity",description:"Liste des tentatives, paiements, refus et remboursements",inputSchema:{type:"object",properties:{}}},
    {name:"payments_review_queue",description:"Transactions déjà payées en attente de validation propriétaire",inputSchema:{type:"object",properties:{}}}
  ];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url||"/","http://localhost");
    const path=url.pathname;
    try {
      if(req.method==="GET" && path==="/health") return result(res,200,{status:"ok",service:"CHK Paiements Sidecar",version:"0.1",mcp_universal_untouched:true});
      if(req.method==="POST" && path==="/api/v1/stripe/webhook") {
        if(!config.webhookSecret) return result(res,503,{error:"stripe_webhook_not_configured"});
        const raw=await readRaw(req);
        if(!verifyStripeSignature(raw,req.headers["stripe-signature"],config.webhookSecret))
          return result(res,400,{error:"invalid_stripe_signature"});
        const event=JSON.parse(raw.toString("utf8"));
        const accepted=await hub.acceptVerifiedStripeEvent(event);
        return result(res,200,{received:true,duplicate:accepted.duplicate});
      }
      if(req.method==="POST" && path==="/api/v1/pair") {
        const source=req.socket.remoteAddress||"unknown",entry=fails.get(source)||{attempts:0,expires:0};
        if(entry.expires>Date.now() && entry.attempts>=5) return result(res,429,{error:"pair_rate_limited"});
        const body=await readJson(req);
        try {
          const paired=await devices.pair(body.code,body.device_name);
          fails.delete(source);
          return result(res,201,paired);
        } catch(e) {
          fails.set(source,{attempts:entry.attempts+1,expires:Date.now()+15*60000});
          return result(res,403,{error:"pairing_denied"});
        }
      }
      if(path==="/mcp") {
        // This is a distinct sidecar MCP. Never change the Universal Control /mcp.
        if(req.method!=="POST") return result(res,405,{error:"post_required"});
        const mcpAuth=String(req.headers.authorization||"").replace(/^Bearer /i,"");
        if(config.mcpReadToken.length<32 || !compare(sha(mcpAuth),sha(config.mcpReadToken)))
          return result(res,401,{error:"dedicated_mcp_auth_required"});
        const rpc=await readJson(req);
        const payload=(value)=>result(res,200,{jsonrpc:"2.0",id:rpc.id??null,result:value});
        if(rpc.method==="initialize")
          return payload({protocolVersion:"2025-06-18",capabilities:{tools:{listChanged:false}},serverInfo:{name:"CHK Paiements",version:"0.1"}});
        if(rpc.method==="notifications/initialized") return result(res,202,{accepted:true});
        if(rpc.method==="tools/list") return payload({tools:mcpTools});
        if(rpc.method==="tools/call") {
          const name=rpc.params?.name;
          const data=name==="payments_status" ? {service:"CHK Paiements",orders:hub.getActivity().length,awaiting_review:hub.getReviewQueue().length} :
            name==="payments_activity" ? hub.getActivity().slice(0,100) :
            name==="payments_review_queue" ? hub.getReviewQueue().slice(0,100) : null;
          if(data===null) return result(res,200,{jsonrpc:"2.0",id:rpc.id??null,error:{code:-32601,message:"Unknown or forbidden tool"}});
          return payload({content:[{type:"text",text:JSON.stringify(data)}]});
        }
        return result(res,200,{jsonrpc:"2.0",id:rpc.id??null,error:{code:-32601,message:"Method not found"}});
      }
      if(!path.startsWith("/api/v1/")) return result(res,404,{error:"not_found"});
      const bearer=String(req.headers.authorization||"").replace(/^Bearer /i,"");
      const device=await devices.authorize(bearer);
      if(!device) return result(res,401,{error:"owner_device_required"});
      if(req.method==="GET"&&path==="/api/v1/activity") return result(res,200,{items:hub.getActivity().slice(0,100)});
      if(req.method==="GET"&&path==="/api/v1/review-queue") return result(res,200,{items:hub.getReviewQueue().slice(0,100)});
      if(req.method==="GET"&&path==="/api/v1/status") return result(res,200,{status:"ok",pending:hub.getReviewQueue().length});
      if(req.method==="POST"&&path==="/api/v1/reviews") {
        const body=await readJson(req);
        if(!["approve","deny"].includes(body.decision)) return result(res,400,{error:"invalid_decision"});
        const reviewed=await hub.reviewPaidOrder({order_id:body.order_id,decision:body.decision,reviewer_id:device.id});
        return result(res,200,reviewed);
      }
      return result(res,404,{error:"not_found"});
    }catch(e){
      return result(res,/^(invalid_|unknown_|order_|checkout_|body_|json_|device_|pair_|session_)/.test(e.message)?400:500,
        {error:/^(invalid_|unknown_|order_|checkout_|body_|json_|device_|pair_|session_)/.test(e.message)?e.message:"internal_error"});
    }
  });
  server.requestTimeout=30000;
  server.headersTimeout=12000;
  return {server,hub,devices,config};
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const {server,config}=await buildPaymentSidecar();
  server.listen(config.port,config.host,()=>console.log("CHK Paiements local sidecar on 127.0.0.1:"+config.port));
}
