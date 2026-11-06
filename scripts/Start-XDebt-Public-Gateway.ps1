# XDebt public gateway — start only after local CHK Universal is up-to-date.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$gateway = Join-Path $root 'src\xdebt-public-gateway.mjs'
if (-not (Test-Path $gateway)) { throw "Passerelle XDebt absente : $gateway" }
$serverPort = 8787
$port = 8798
Write-Host "Verification du serveur CHK Universal local..." -ForegroundColor Cyan
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$serverPort/xdebt/api/health" -TimeoutSec 6
} catch {
  throw "XDebt indisponible sur le serveur personnel. Mettre a jour/redemarrer CHK Universal avant d'exposer une route publique. (Erreur: $($_.Exception.Message))"
}
if ($health.service -ne 'XDebt' -or $health.status -ne 'ok') { throw 'Service XDebt invalide' }
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Le port local $port est deja occupe : aucun service n'a ete remplace." }
Write-Host "Serveur CHK Universal OK. Passerelle XDebt sur 127.0.0.1:$port" -ForegroundColor Green
Write-Host "Aucune route Tailscale, MCP, proxy public ou pare-feu n'est modifiee." -ForegroundColor Yellow
$env:XDEBT_PUBLIC_ENABLED = 'true'
$env:XDEBT_PUBLIC_PORT = [string]$port
$env:PORT = [string]$serverPort
& node $gateway
