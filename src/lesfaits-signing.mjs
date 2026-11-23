import { createPublicKey, randomBytes, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const call = promisify(execFile);
const ISSUER = "https://token.actions.githubusercontent.com";
const REPOSITORY = "Chasmet/Probl-me-r-curent-travail-";
const EXPECTED = Object.freeze({
  repository: REPOSITORY,
  repository_id: "1467654431",
  repository_owner_id: "160381695",
  actor_id: "160381695",
  ref: "refs/heads/main",
  workflow_ref: REPOSITORY+"/.github/workflows/release.yml@refs/heads/main",
  runner_environment: "github-hosted"
});
let cache=null, expiration=0;

export function allowedLesFaitsClaims(claims,audience,now=Math.floor(Date.now()/1000)){
  return Boolean(claims && typeof claims==="object"
    && Object.entries(EXPECTED).every(([field,expected])=>String(claims[field]??"")===expected)
    && claims.event_name==="workflow_dispatch"
    && claims.iss===ISSUER && claims.aud===audience
    && claims.sub==="repo:"+REPOSITORY+":ref:refs/heads/main"
    && ["exp","nbf","iat"].every(field=>Number.isInteger(claims[field]))
    && claims.nbf<=now+30 && claims.iat<=now+30
    && claims.exp>now-30 && claims.exp>claims.iat && claims.exp-claims.iat<=600
    && now-claims.iat<=600);
}
async function githubKeys() {
  if(cache && Date.now()<expiration)return cache;
  const response=await fetch(ISSUER+"/.well-known/jwks",{
    redirect:"error",signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw Error("github_jwks_unavailable");
  const data=await response.json();
  if(!Array.isArray(data.keys)||data.keys.length>30)throw Error("invalid_github_jwks");
  cache=data.keys;expiration=Date.now()+600000;
  return cache;
}
export async function verifyLesFaitsOidc(jwt,audience,fetchKeys=githubKeys){
  if(typeof jwt!=="string" || jwt.length<100 || jwt.length>20000)return false;
  const parts=jwt.split(".");
  if(parts.length!==3 || parts.some(part=>!part))return false;
  try {
    const header=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));
    const claims=JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));
    if(header.alg!=="RS256" || typeof header.kid!=="string" || header.kid.length>256
        || !allowedLesFaitsClaims(claims,audience))return false;
    const keys=await fetchKeys();
    const jwk=keys.find(key=>key.kty==="RSA" && key.kid===header.kid
        && (!key.alg || key.alg==="RS256"));
    return !!jwk && verify("RSA-SHA256",Buffer.from(parts[0]+"."+parts[1]),
      createPublicKey({key:jwk,format:"jwk"}),Buffer.from(parts[2],"base64url"));
  } catch {return false;}
}
async function isFile(file) {
  try{return (await stat(file)).isFile();}
  catch(e){if(e.code==="ENOENT")return false;throw e;}
}
const PS=[
  "$ErrorActionPreference='Stop'",
  "$rsa=[System.Security.Cryptography.RSACng]::new(3072)",
  "$cert=$null",
  "try {",
  " $dn=[System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=LES FAITS SYNC 30')",
  " $req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new($dn,$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
  " $start=[System.DateTimeOffset]::UtcNow.AddMinutes(-5)",
  " $end=[System.DateTimeOffset]::UtcNow.AddYears(20)",
  " $cert=$req.CreateSelfSigned($start,$end)",
  " $pfx=$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$env:LF_PFX_PASSWORD)",
  " [System.IO.File]::WriteAllBytes($env:LF_PFX_PATH,$pfx)",
  " if (![System.IO.File]::Exists($env:LF_PFX_PATH)) {throw 'signing_missing'}",
  "} finally {if ($cert -ne $null) {$cert.Dispose()};$rsa.Dispose()}"
].join("\n");

export class LesFaitsSigner {
  constructor(config) {
    this.folder=join(dirname(config.file),"lesfaits-signing");
    this.pfx=join(this.folder,"release.pfx");
    this.credentials=join(this.folder,"credentials.json");
    this.pending=null;
  }
  signing(){
    if(!this.pending)this.pending=this.load().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async load(){
    await mkdir(this.folder,{recursive:true,mode:0o700});
    const hasPfx=await isFile(this.pfx),hasPassword=await isFile(this.credentials);
    if(hasPfx!==hasPassword)throw Error("signing_inconsistent");
    if(!hasPfx){
      if(process.platform!=="win32")throw Error("signing_requires_windows");
      const password=randomBytes(32).toString("hex");
      const tmp=join(this.folder,"new-"+randomBytes(8).toString("hex")+".pfx");
      try{
        await call("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",
          Buffer.from(PS,"utf16le").toString("base64")],{
          env:{...process.env,LF_PFX_PASSWORD:password,LF_PFX_PATH:tmp},
          timeout:90000,windowsHide:true,maxBuffer:20000
        });
        if(!(await isFile(tmp)))throw Error("signing_missing");
        await rename(tmp,this.pfx);
        await writeFile(this.credentials,JSON.stringify({password,created_at:new Date().toISOString()}),
          {mode:0o600,flag:"wx"});
      }finally{await rm(tmp,{force:true}).catch(()=>{});}
    }
    const credentials=JSON.parse(await readFile(this.credentials,"utf8"));
    const data=await readFile(this.pfx);
    if(!/^[0-9a-f]{64}$/.test(credentials.password)||data.length<400||data.length>100000)
      throw Error("invalid_signer");
    return {keystoreBase64:data.toString("base64"),storePassword:credentials.password,
      keyPassword:credentials.password,storeType:"PKCS12"};
  }
}
