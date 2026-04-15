$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8000
$runtimeConfigPath = Join-Path $workspace ".xo-runtime.json"
$runtimeScriptPath = Join-Path $workspace "public\\runtime-config.js"

$adapters = @()
$currentAdapter = $null

foreach ($line in (ipconfig)) {
  if ($line -match 'adapter (.+):\s*$') {
    if ($currentAdapter) {
      $adapters += [pscustomobject]$currentAdapter
    }
    $currentAdapter = [ordered]@{
      Name = $matches[1]
      IPv4 = ""
      Subnet = ""
      Gateway = ""
    }
    continue
  }

  if (-not $currentAdapter) {
    continue
  }

  if ($line -match 'IPv4.*:\s*(\d+\.\d+\.\d+\.\d+)\s*$') {
    $currentAdapter.IPv4 = $matches[1]
    continue
  }

  if ($line -match 'Subnet Mask.*:\s*(\d+\.\d+\.\d+\.\d+)\s*$') {
    $currentAdapter.Subnet = $matches[1]
    continue
  }

  if ($line -match 'Default Gateway.*:\s*(\d+\.\d+\.\d+\.\d+)\s*$') {
    $currentAdapter.Gateway = $matches[1]
  }
}

if ($currentAdapter) {
  $adapters += [pscustomobject]$currentAdapter
}

$usableAdapters = $adapters |
  Where-Object {
    $_.IPv4 -and
    $_.IPv4 -notlike '127.*' -and
    $_.IPv4 -notlike '169.254.*'
  }

$addresses = $usableAdapters | Select-Object -ExpandProperty IPv4 -Unique

$preferredAddress = $usableAdapters |
  Sort-Object `
    @{ Expression = { if ($_.Gateway) { 0 } else { 1 } } }, `
    @{ Expression = { if ($_.Subnet -eq '255.255.255.255') { 1 } else { 0 } } } |
  Select-Object -ExpandProperty IPv4 -First 1
if ($preferredAddress) {
  $baseUrl = "http://$preferredAddress`:$port"
  @{ baseUrl = $baseUrl } | ConvertTo-Json | Set-Content -Path $runtimeConfigPath -Encoding UTF8
  "window.XO_RUNTIME = { baseUrl: '$baseUrl' };" | Set-Content -Path $runtimeScriptPath -Encoding UTF8
} else {
  @{ baseUrl = "" } | ConvertTo-Json | Set-Content -Path $runtimeConfigPath -Encoding UTF8
  "window.XO_RUNTIME = { baseUrl: '' };" | Set-Content -Path $runtimeScriptPath -Encoding UTF8
}

Write-Host ""
Write-Host "XO Classic Online"
Write-Host "-----------------"
Write-Host "Локальный запуск:  http://localhost:$port"

foreach ($address in $addresses) {
  Write-Host "По сети:           http://$address`:$port"
}

Write-Host ""
Write-Host "Запуск сервера..."
Write-Host ""

Set-Location $workspace
python server.py
