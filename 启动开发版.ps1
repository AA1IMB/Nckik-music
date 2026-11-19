# Launch Nckik's music for development from inside this environment.
#
# Fixes three local quirks so you do not have to remember them:
#   1. ELECTRON_RUN_AS_NODE is set machine-wide -> Electron would run as plain Node.
#   2. Chromium's sandbox cannot initialize here -> needs --no-sandbox.
#   3. %TEMP% is restricted -> probes fail on fs.mkdtemp; TMP/TEMP point into the workspace.
#
# Usage:
#   .\启动开发版.ps1                 start the app
#   .\启动开发版.ps1 -Probe brand    run one probe (brand|edge|quality-ui|src-home|myplaylists)
#   .\启动开发版.ps1 -Probe all      run every GUI probe in sequence

param(
  [string]$Probe = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root 'player'
$exe = Join-Path $app 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path -LiteralPath $exe)) {
  Write-Host "Electron runtime not found. Running npm ci first..."
  Push-Location $app
  try { npm ci --no-audit --no-fund } finally { Pop-Location }
  if (-not (Test-Path -LiteralPath $exe)) { throw "Install failed: $exe still missing." }
}

$env:ELECTRON_RUN_AS_NODE = $null

$tmp = Join-Path $root '.tmp'
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$env:TMP = $tmp
$env:TEMP = $tmp

$probes = @('brand', 'edge', 'quality-ui', 'src-home')

# Electron is a GUI-subsystem binary: a plain `& $exe` returns immediately and
# leaves $LASTEXITCODE stale, so wait explicitly and take the real exit code.
function Invoke-Electron([string[]]$electronArgs) {
  Push-Location $app
  try {
    $p = Start-Process -FilePath $exe -ArgumentList $electronArgs -NoNewWindow -Wait -PassThru
    return $p.ExitCode
  } finally {
    Pop-Location
  }
}

if (-not $Probe) {
  $code = Invoke-Electron @('--no-sandbox', '.')
  exit $code
}

if ($Probe -eq 'myplaylists') {
  Push-Location $app
  try { node demo\probe-myplaylists.js; exit $LASTEXITCODE } finally { Pop-Location }
}

if ($Probe -eq 'all') { $probes = @('myplaylists', 'brand', 'edge', 'quality-ui', 'src-home') }
elseif ($probes -notcontains $Probe) {
  throw "Unknown probe '$Probe'. Choose: $($probes -join ', '), or 'all'."
}
else { $probes = @($Probe) }

$failed = 0
foreach ($name in $probes) {
  Write-Host ""
  Write-Host "===== probe: $name ====="
  if ($name -eq 'myplaylists') {
    Push-Location $app
    try { node demo\probe-myplaylists.js; if ($LASTEXITCODE -ne 0) { $failed++ } } finally { Pop-Location }
  } else {
    $code = Invoke-Electron @('--no-sandbox', "demo\probe-$name.js")
    if ($code -ne 0) { $failed++ }
  }
}

Write-Host ""
if ($failed) { Write-Host "$failed probe(s) exited non-zero."; exit 1 }
Write-Host "All requested probes finished."
exit 0
