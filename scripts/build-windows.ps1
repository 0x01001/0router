<#
.SYNOPSIS
  Build (and optionally run) the 9Router CLI bundle natively on Windows.

.DESCRIPTION
  Native Windows replacement for `make release` on this repo. The Makefile
  targets rely on bash/lsof/pgrep/curl/nohup and cannot run on native Windows,
  but the actual build (npm --prefix cli run build -> node scripts/build-cli.js)
  is fully cross-platform. This script wires that up with dependency install,
  build, and an optional local run — no make, bash, or WSL required.

.PARAMETER Install
  Install npm dependencies (repo root + cli) before building.

.PARAMETER Run
  Start the built server after a successful build.

.PARAMETER Port
  Port to run the server on (default 20128). Only used with -Run.

.PARAMETER SkipBuild
  Skip the build step (useful with -Run to just start an existing bundle).

.EXAMPLE
  # First time: install deps, build, then run
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Install -Run

.EXAMPLE
  # Just rebuild the bundle
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1

.EXAMPLE
  # Build then run on a custom port
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Run -Port 20200
#>

[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Run,
  [int]$Port = 20128,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Resolve repo root (this script lives in <root>\scripts).
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$CliDir = Join-Path $RootDir "cli"

function Write-Step {
  param([string]$Message)
  Write-Host "[build-windows] $Message" -ForegroundColor Cyan
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found on PATH. Install Node.js (which includes npm) from https://nodejs.org and reopen the terminal."
  }
}

Assert-Command -Name "node"
Assert-Command -Name "npm"

$nodeVersion = (& node --version)
Write-Step "Using Node $nodeVersion at $RootDir"

if ($Install) {
  Write-Step "Installing root dependencies (npm install)..."
  Push-Location $RootDir
  try { npm install } finally { Pop-Location }

  Write-Step "Installing CLI dependencies (npm --prefix cli install)..."
  Push-Location $RootDir
  try { npm --prefix cli install } finally { Pop-Location }
}

if (-not $SkipBuild) {
  # Guard: fail early with a clear message if deps are missing.
  $nextBin = Join-Path $RootDir "node_modules\next"
  $esbuildBin = Join-Path $CliDir "node_modules\esbuild"
  if (-not (Test-Path $nextBin) -or -not (Test-Path $esbuildBin)) {
    throw "Build dependencies are missing. Re-run with -Install (e.g. scripts\build-windows.ps1 -Install)."
  }

  Write-Step "Building CLI bundle (npm --prefix cli run build)..."
  Push-Location $RootDir
  try {
    npm --prefix cli run build
    if ($LASTEXITCODE -ne 0) { throw "CLI build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $cliAppDir = Join-Path $CliDir "app"
  Write-Step "Build complete. Bundle output: $cliAppDir"
}

if ($Run) {
  $cliJs = Join-Path $CliDir "cli.js"
  if (-not (Test-Path $cliJs)) {
    throw "CLI launcher not found: $cliJs"
  }
  Write-Step "Starting server: node cli\cli.js --port $Port"
  Push-Location $CliDir
  try {
    & node "cli.js" "--port" "$Port"
  } finally {
    Pop-Location
  }
}
