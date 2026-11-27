$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$playerDir = Split-Path -Parent $here
$binDir = Join-Path $playerDir 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$vcvars = 'D:\c++chan\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
  throw "找不到 MSVC 环境脚本: $vcvars"
}

$src = Join-Path $here 'nckik_audio.cpp'
$out = Join-Path $binDir 'nckik-audio.exe'
$obj = Join-Path $here 'nckik_audio.obj'

$cmd = "call `"$vcvars`" >nul && cl /nologo /O2 /MT /EHsc /std:c++20 /utf-8 /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX `"$src`" /Fo:`"$obj`" /Fe:`"$out`" ole32.lib avrt.lib mfplat.lib mfreadwrite.lib mfuuid.lib propsys.lib ksuser.lib"
cmd /c $cmd
$rc = $LASTEXITCODE
Remove-Item $obj -Force -ErrorAction SilentlyContinue
if ($rc -ne 0) {
  throw "编译 nckik-audio.exe 失败 (exit=$rc)"
}

$len = (Get-Item $out).Length
Write-Host "Built $out ($([math]::Round($len / 1024, 1)) KB)"
