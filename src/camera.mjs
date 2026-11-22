import { createPublicKey, randomBytes, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const invoke = promisify(execFile);
const ISSUER = "https://token.actions.githubusercontent.com";
export const CAMERA_PREFIX = "/camera/api";
const EXPECTED = {
  repository: "Chasmet/Camera-maison", repository_id: "1467502821",
  repository_owner_id: "160381695", actor_id: "160381695",
  ref: "refs/heads/main",
  workflow_ref: "Chasmet/Camera-maison/.github/workflows/build.yml@refs/heads/main",
  runner_environment: "github-hosted"
};
let keysCache = null, keysExpires = 0;

export function allowedCameraClaims(claims, aud, now = Math.floor(Date.now()/1000)) {
  if (!claims || typeof claims !== "object") return false;
  if (Object.entries(EXPECTED).some(([key,val]) => String(claims[key] ?? "") !== val)) return false;
  if (!["push","workflow_dispatch"].includes(claims.event_name)) return false;
  if (claims.iss !== ISSUER || claims.aud !== aud ||
      claims.sub !== "repo:Chasmet/Camera-maison:ref:refs/heads/main") return false;
  if (!["exp","nbf","iat"].every(x => Number.isInteger(claims[x]))) return false;
  if (claims.nbf > now+30 || claims.iat > now+30 || claims.exp <= now-30 ||
      claims.exp <= claims.iat || claims.exp-claims.iat > 600 || now-claims.iat > 600) return false;
  return true;
}
async function publicKeys() {
  if (keysCache && Date.now() < keysExpires) return keysCache;
  const res = await fetch(ISSUER+"/.well-known/jwks", { redirect:"error", signal:AbortSignal.timeout(12000) });
  if (!res.ok) throw Error("github_identity_unavailable");
  const value = await res.json();
  if (!Array.isArray(value.keys) || value.keys.length > 30) throw Error("github_keys_invalid");
  keysCache = value.keys; keysExpires = Date.now() + 600000;
  return keysCache;
}
export async function verifyCameraOidc(token, audience, getKeys = publicKeys) {
  if (typeof token !== "string" || token.length < 100 || token.length > 20000) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(p => !p)) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));
    if (header.alg !== "RS256" || typeof header.kid !== "string" ||
        header.kid.length > 256 || !allowedCameraClaims(claims,audience)) return false;
    const jwk = (await getKeys()).find(k => k.kty==="RSA" && k.kid===header.kid && (!k.alg || k.alg==="RS256"));
    return !!jwk && verify("RSA-SHA256",Buffer.from(parts[0]+"."+parts[1]),
      createPublicKey({key:jwk,format:"jwk"}),Buffer.from(parts[2],"base64url"));
  } catch { return false; }
}
async function exists(path) {
  try { return (await stat(path)).isFile(); }
  catch(e) { if(e.code==="ENOENT") return false; throw e; }
}
const PS = [
 "$ErrorActionPreference='Stop'",
 "$rsa=[System.Security.Cryptography.RSACng]::new(3072)",
 "$cert=$null",
 "try {",
 " $dn=[System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=CHK Camera Maison')",
 " $req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new($dn,$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
 " $start=[System.DateTimeOffset]::UtcNow.AddMinutes(-5)",
 " $end=[System.DateTimeOffset]::UtcNow.AddYears(20)",
 " $cert=$req.CreateSelfSigned($start,$end)",
 " $pfx=$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$env:CHK_CAMERA_PFX_PASSWORD)",
 " [System.IO.File]::WriteAllBytes($env:CHK_CAMERA_PFX_PATH,$pfx)",
 " if (![System.IO.File]::Exists($env:CHK_CAMERA_PFX_PATH)) {throw 'missing_pfx'}",
 "} finally {if ($cert -ne $null) {$cert.Dispose()}; $rsa.Dispose()}"
].join("\n");

export class CameraMaisonModule {
  constructor(config) {
    this.base=config.base;
    this.folder=join(dirname(config.file),"camera-maison-signing");
    this.key=join(this.folder,"release.pfx");
    this.passwordFile=join(this.folder,"credentials.json");
    this.loading=null;
  }
  signing() {
    if(!this.loading) this.loading=this.load().finally(()=>{this.loading=null});
    return this.loading;
  }
  async load() {
    await mkdir(this.folder,{recursive:true,mode:0o700});
    const k=await exists(this.key), p=await exists(this.passwordFile);
    if(k!==p) throw Error("signing_state_partial");
    if(!k) {
      if(process.platform!=="win32") throw Error("signing_requires_windows");
      const password=randomBytes(32).toString("hex");
      const tmp=join(this.folder,"new-"+randomBytes(8).toString("hex")+".pfx");
      try {
        await invoke("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",
          Buffer.from(PS,"utf16le").toString("base64")],{
          env:{...process.env,CHK_CAMERA_PFX_PASSWORD:password,CHK_CAMERA_PFX_PATH:tmp},
          windowsHide:true,timeout:90000,maxBuffer:20000
        });
        if(!(await exists(tmp))) throw Error("signing_export_missing");
        await rename(tmp,this.key);
        await writeFile(this.passwordFile,JSON.stringify({password,created_at:new Date().toISOString()}),
          {mode:0o600,flag:"wx"});
      } finally {await rm(tmp,{force:true}).catch(()=>{});}
    }
    const credential=JSON.parse(await readFile(this.passwordFile,"utf8"));
    const bytes=await readFile(this.key);
    if(!/^[0-9a-f]{64}$/.test(credential.password)||bytes.length<400||bytes.length>100000)
      throw Error("signing_state_invalid");
    return {keystoreBase64:bytes.toString("base64"),storePassword:credential.password,
      keyPassword:credential.password,storeType:"PKCS12"};
  }
  async handle(req,res,url,_body,json) {
    const path=url.pathname.slice(CAMERA_PREFIX.length);
    if(path==="/health") {
      if(req.method!=="GET") return json(res,405,{error:"method_not_allowed"});
      return json(res,200,{status:"ok",service:"Camera-maison",backend:"CHK Universal PC",
        live_aiwit_p2p:false,update_source:"GitHub Releases"});
    }
    if(path!=="/ci/signing") return json(res,404,{error:"not_found"});
    if(req.method!=="GET") return json(res,405,{error:"method_not_allowed"});
    res.setHeader("cache-control","no-store");
    const bearer=/^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization||"")?.[1];
    if(!bearer) return json(res,401,{error:"github_oidc_required"});
    if(!(await verifyCameraOidc(bearer,this.base+CAMERA_PREFIX+"/ci/signing")))
      return json(res,403,{error:"workflow_forbidden"});
    try {return json(res,200,await this.signing());}
    catch {return json(res,503,{error:"signer_not_ready"});}
  }
}
