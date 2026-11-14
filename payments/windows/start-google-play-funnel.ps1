param([switch]$ExposeFunnel, [int]$ExternalHttpsPort=10000, [int]$GatewayPort=8792)
$ErrorActionPreference="Stop"
$Script=Join-Path (Split-Path -Parent $PSScriptRoot) "public-play-gateway.mjs"
if($ExternalHttpsPort -ne 10000){throw "Port public fixe 10000 : 443 est le MCP universel et 8443 appartient à CHK Paiements privé."}
if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw "Node.js 22 requis"}
if(-not (Test-Path $Script)){throw "Module gateway absent"}
try {
  $health=Invoke-RestMethod -Uri "http://127.0.0.1:8791/api/v1/play/health" -TimeoutSec 5
} catch {throw "Sidecar CHK Paiements non disponible : arret de securite"}
if($health.billingReady -ne $true){throw "Google Play Service Account non configure, impossible d'exposer"}
if(Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue){
  throw "Port $GatewayPort deja occupe"}
$env:CHK_PLAY_GATEWAY_PORT="$GatewayPort"
try {
  $process=Start-Process -FilePath (Get-Command node).Source -ArgumentList @($Script) -PassThru -WindowStyle Hidden
} finally {Remove-Item Env:CHK_PLAY_GATEWAY_PORT -ErrorAction SilentlyContinue}
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
# Ne jamais prendre un port configuré pour Serve privé ni pour un autre Funnel.
$serveRaw = & tailscale serve status --json 2>&1
if($LASTEXITCODE -ne 0){throw "Impossible d'inspecter les ports Tailscale existants. Aucun Funnel activé."}
$serveText = ($serveRaw | Out-String)
$serveConfig = $serveText | ConvertFrom-Json
if($serveConfig.Web){
  foreach($entry in $serveConfig.Web.PSObject.Properties){
    if ($entry.Name -match '(^|:)10000$') {
      throw "Port HTTPS 10000 déjà utilisé par Tailscale Serve/Funnel. Arrêt de sécurité : aucune modification."
    }
  }
}
$statuses = & tailscale funnel status 2>&1
Write-Host "Le port 10000 devient PUBLIC sur Internet, uniquement pour la vérification Google Play."
Write-Host "Les ports existants 443 (MCP) et 8443 (Paiements privé) restent inchangés."
tailscale funnel --bg --https=10000 "http://127.0.0.1:$GatewayPort"
if($LASTEXITCODE -ne 0){throw "Tailscale a refusé Funnel 10000"}
tailscale funnel status
