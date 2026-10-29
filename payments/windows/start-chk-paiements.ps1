# CHK Paiements - installation locale distincte de CHK Universal Control /mcp.
# NE JAMAIS modifier la route 443, ne jamais appeler tailscale serve reset.
[CmdletBinding()]
param([switch]$NoPairCode)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$tailscale = (Get-Command tailscale.exe -ErrorAction Stop).Source
$version = & $node --version
if ($LASTEXITCODE -ne 0 -or [int](($version -replace '^v','').Split('.')[0]) -lt 22) {
  throw 'Node.js version 22 ou supérieure nécessaire.'
}
$env:PAYMENTS_DATA_FILE = Join-Path $root 'data\payments-orders.json'
$env:PAYMENTS_DEVICES_FILE = Join-Path $root 'data\payment-devices.json'
$env:PAYMENTS_PORT = '8791'
$endpoint = 'https://chk-universal-1.taild9e4de.ts.net:8443'
$localHealth = 'http://127.0.0.1:8791/health'

$alreadyRunning = $false
try {
  $health = Invoke-RestMethod -Uri $localHealth -TimeoutSec 3
  if ($health.service -ne 'CHK Paiements Sidecar') {
    throw 'Port local 8791 occupé par un service différent. Arrêt de sécurité.'
  }
  $alreadyRunning = $true
} catch [System.Net.WebException] {
  $alreadyRunning = $false
} catch [System.Net.Http.HttpRequestException] {
  $alreadyRunning = $false
}
if (-not $alreadyRunning) {
  $entry = Join-Path $root 'payments\sidecar.mjs'
  if (-not (Test-Path $entry)) { throw 'Module sidecar introuvable dans cette branche.' }
  $proc = Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  try {
    $health = Invoke-RestMethod -Uri $localHealth -TimeoutSec 7
    if ($health.service -ne 'CHK Paiements Sidecar') { throw 'Service local incorrect.' }
  } catch {
    throw ('Service Paiements local non démarré. PID=' + $proc.Id + '. ' + $_.Exception.Message)
  }
}
Write-Host 'CHK Paiements sidecar local : OK' -ForegroundColor Green

# Before adding a new HTTPS endpoint, inspect the existing Serve configuration.
$statusRaw = & $tailscale serve status --json 2>&1
if ($LASTEXITCODE -ne 0) { throw ('Impossible de lire tailscale serve status : ' + ($statusRaw -join ' ')) }
$config = $statusRaw | ConvertFrom-Json
$exists = $false
if ($config.Web) {
  foreach ($entry in $config.Web.PSObject.Properties) {
    if ($entry.Name -match '(^|:)8443$') {
      $exists = $true
      $dump = ($entry.Value | ConvertTo-Json -Depth 8 -Compress)
      if ($dump -notmatch '127\.0\.0\.1:8791') {
        throw 'HTTPS 8443 déjà configuré pour un autre service. Aucune modification réalisée.'
      }
    }
  }
}
if (-not $exists) {
  & $tailscale serve --bg --https=8443 http://127.0.0.1:8791
  if ($LASTEXITCODE -ne 0) { throw 'Publication HTTPS Paiements sur 8443 refusée par Tailscale.' }
}
Write-Host ('Paiements : ' + $endpoint) -ForegroundColor Cyan
Write-Host 'MCP UNIVERSAL CONTROL sur 443 et /mcp : INCHANGÉ.' -ForegroundColor Green

if (-not $NoPairCode) {
  & $node (Join-Path $root 'payments\pair-code.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Impossible de générer un code d appairage.' }
}
Write-Host 'Pour la continuité après redémarrage, relancer ce script ou créer une tâche Windows dédiée.' -ForegroundColor Yellow
