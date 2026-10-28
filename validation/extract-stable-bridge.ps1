param(
  [Parameter(Mandatory=$true)][string]$ReleaseExe,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference='Stop'
$expected='AEE127E17922D2533D7370B066294AB81A50771ABC14366C618AC903E27FC7F3'
$release=(Resolve-Path $ReleaseExe).Path
$actual=(Get-FileHash -Algorithm SHA256 -Path $release).Hash
if ($actual -ne $expected) { throw 'Refused: stable 1.0.4 release SHA-256 mismatch' }
Add-Type -AssemblyName System.IO.Compression
$assembly=[System.Reflection.Assembly]::LoadFile($release)
$stream=$assembly.GetManifestResourceStream('chk.runtime')
if ($null -eq $stream) { throw 'Stable EXE missing runtime resource' }
try {
  $zip=New-Object System.IO.Compression.ZipArchive($stream,[System.IO.Compression.ZipArchiveMode]::Read,$false)
  try {
    $entry=$zip.GetEntry('tailscale-bridge.exe')
    if ($null -eq $entry -or $entry.Length -lt 100000) { throw 'Stable release missing the verified Tailscale bridge' }
    $dir=Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force $dir | Out-Null
    $source=$entry.Open()
    try {
      $target=[System.IO.File]::Create($Destination)
      try { $source.CopyTo($target) } finally { $target.Dispose() }
    } finally { $source.Dispose() }
  } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
$bytes=[System.IO.File]::ReadAllBytes($Destination)
if ($bytes.Length -lt 100000 -or $bytes[0] -ne 77 -or $bytes[1] -ne 90) { throw 'Extracted bridge is not a real PE EXE' }
$env:CHK_UNIVERSAL_HOME=Join-Path $env:TEMP 'chk-local-ai-bridge-smoketest'
& $Destination '--diagnostic-storage'
if ($LASTEXITCODE -ne 0) { throw 'Stable Tailscale bridge Windows smoke test failed' }
Write-Host 'PASS: stable 1.0.4 Tailscale bridge reused byte-for-byte; no new network configuration'
