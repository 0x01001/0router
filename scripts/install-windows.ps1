<#
.SYNOPSIS
  Install npm dependencies for local 9Router development/build on Windows.
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir

function Write-Step {
  param([string]$Message)
  Write-Host "[install-windows] $Message" -ForegroundColor Cyan
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required but was not found on PATH."
}

Write-Step "Installing root dependencies (npm install)..."
Push-Location $RootDir
try { npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } } finally { Pop-Location }

Write-Step "Installing CLI dependencies (npm --prefix cli install)..."
Push-Location $RootDir
try { npm --prefix cli install; if ($LASTEXITCODE -ne 0) { throw "npm --prefix cli install failed" } } finally { Pop-Location }

Write-Step "Install complete."
