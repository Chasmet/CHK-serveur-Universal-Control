import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Strictly local proxy for the public Tailscale Funnel edge.
// Never forwards MCP, Stripe, pairing, owner admin, or arbitrary routes.
const send=(res,status,obj)=>{
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",
    "x-content-type-options":"nosniff","referrer-policy":"no-referrer"});
  res.end(JSON.stringify(obj));
};
const hash=s=>createHash("sha256").update(s).digest("hex");
const ALLOWED_NOTE_PACKAGES=new Set(["com.chk.blocnote","com.sync30.mesnotesdossiers"]);
const readBody=async(req,limit)=>{
  let bytes=0,parts=[];
  for await(const part of req){
    bytes+=part.length;
    if(bytes>limit) throw Error("too_large");
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
};
export function buildPublicPlayGateway(opts={}){
  const host=opts.host||"127.0.0.1",port=opts.port??Number(process.env.CHK_PLAY_GATEWAY_PORT||8792);
  const upstream=opts.upstream||"http://127.0.0.1:8791";
  const request=opts.fetchFn||fetch, now=opts.now||Date.now, hit=new Map();
  if(host!=="127.0.0.1"&&host!=="::1")throw Error("gateway_must_be_loopback_only");
  const u=new URL(upstream);
  if(u.protocol!=="http:" || !["localhost","127.0.0.1","::1"].includes(u.hostname)
     || u.pathname!=="/" || u.search || u.username || u.password)throw Error("upstream_must_be_local");
  const limit=(key,max)=>{
    const t=now(),prior=hit.get(key);
    if(!prior||prior.reset<=t){hit.set(key,{n:1,reset:t+60000});return true;}
    if(prior.n>=max)return false;
    prior.n++;return true;
  };
  let inflight=0;
  const handle=async(req,res)=>{
    const u=new URL(req.url||"/","http://localhost");
    if(u.search||u.hash)return send(res,404,{error:"not_found"});
    const health=req.method==="GET"&&u.pathname==="/api/v1/play/health";
    const verify=req.method==="POST"&&u.pathname==="/api/v1/play/verify";
    if(!health&&!verify)return send(res,404,{error:"not_found"});
    if(!limit("global",150))return send(res,429,{error:"rate_limited"});
    if(inflight>=12)return send(res,503,{error:"busy"});
    if(req.headers["content-encoding"])return send(res,415,{error:"encoding_forbidden"});
    if(verify&&!String(req.headers["content-type"]||"").startsWith("application/json"))
      return send(res,415,{error:"json_required"});
    let body, requestedPackage="";
    if(verify){
      try{
        const input=JSON.parse(await readBody(req,8192));
        if(!ALLOWED_NOTE_PACKAGES.has(input?.packageName) ||
           input?.productId!=="blocnote_premium_lifetime" ||
           typeof input?.purchaseToken!=="string" ||
           input.purchaseToken.length<20 || input.purchaseToken.length>4096)
          return send(res,400,{error:"invalid_purchase"});
        if(!limit("token:"+hash(input.purchaseToken),12))
          return send(res,429,{error:"token_rate_limited"});
        requestedPackage=input.packageName;
        body=JSON.stringify({packageName:input.packageName,
          productId:input.productId,purchaseToken:input.purchaseToken});
      }catch(e){return send(res,e.message==="too_large"?413:400,
          {error:e.message==="too_large"?"too_large":"invalid_json"});}
    }else if(Number(req.headers["content-length"]||0)>0)
      return send(res,400,{error:"unexpected_body"});
    inflight++;
    try{
      const reply=await request(upstream+u.pathname,{
        method:req.method,headers:{"accept":"application/json",
          ...(verify?{"content-type":"application/json"}:{})},
        ...(verify?{body}:{}),signal:AbortSignal.timeout(11000)
      });
      if(![200,403].includes(reply.status))return send(res,503,{error:"upstream_unavailable"});
      const raw=await reply.text();
      if(raw.length>8192)return send(res,503,{error:"upstream_invalid"});
      const data=JSON.parse(raw);
      if(health)return send(res,200,{ok:true,billingReady:
        reply.status===200&&data?.ok===true&&data?.billingReady===true});
      if(data?.packageName!==requestedPackage||
         data?.productId!=="blocnote_premium_lifetime"||
         typeof data?.verified!=="boolean")
         return send(res,503,{error:"upstream_invalid"});
      if(reply.status===200&&data.verified===true)
         return send(res,200,{verified:true,packageName:data.packageName,productId:data.productId});
      if(reply.status===403&&data.verified===false)
         return send(res,403,{verified:false,packageName:data.packageName,productId:data.productId});
      return send(res,503,{error:"upstream_invalid"});
    }catch{return send(res,503,{error:"upstream_unavailable"});}
    finally{inflight--;}
  };
  const server=createServer((req,res)=>{handle(req,res).catch(()=>send(res,503,{error:"internal_error"}));});
  server.requestTimeout=16000;server.headersTimeout=12000;
  return {server,config:{host,port,upstream}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const {server,config}=buildPublicPlayGateway();
  server.listen(config.port,config.host,()=>console.log("Google Play gateway local: "+config.port));
}
