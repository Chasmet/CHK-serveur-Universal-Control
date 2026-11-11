param([switch]$ExposeFunnel, [int]$ExternalHttpsPort=8443, [int]$GatewayPort=8792)
$ErrorActionPreference="Stop"
$Script=Join-Path (Split-Path -Parent $PSScriptRoot) "public-play-gateway.mjs"
if($ExternalHttpsPort -notin @(8443,10000)){throw "Ne pas modifier 443 : il appartient au MCP universel."}
if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw "Node.js 22 requis"}
if(-not (Test-Path $Script)){throw "Module gateway absent"}
try {
  $health=Invoke-RestMethod -Uri "http://127.0.0.1:8791/api/v1/play/health" -TimeoutSec 5
} catch {throw "Sidecar CHK Paiements non disponible : arret de securite"}
if($health.billingReady -ne $true){throw "Google Play Service Account non configure, impossible d'exposer"}
if(Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue){
  throw "Port $GatewayPort deja occupe"}
$process=Start-Process -FilePath (Get-Command node).Source -ArgumentList @($Script) -PassThru -WindowStyle Hidden -Environment @{CHK_PLAY_GATEWAY_PORT="$GatewayPort"}
Start-Sleep -Seconds 2
try {
  $status=Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/v1/play/health" -TimeoutSec 5
  if($status.billingReady -ne $true){throw "Passerelle non prete"}
} catch {
  Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
  throw
}
Write-Host "CHK Paiements gateway en local, port $GatewayPort; PID $($process.Id)."
if(-not $ExposeFunnel){
  Write-Host "Aucune ouverture publique. Utiliser -ExposeFunnel apres controle Tailscale."
  exit
}
if(-not(Get-Command tailscale -ErrorAction SilentlyContinue)){throw "Tailscale requis"}
tailscale funnel status
Write-Host "Ce port devient PUBLIC sur Internet. Ne jamais exposer le sidecar 8791."
tailscale funnel --bg --https=$ExternalHttpsPort "http://127.0.0.1:$GatewayPort"
tailscale funnel status
