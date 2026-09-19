<#
.SYNOPSIS
  Build and deploy 9Router on native Windows (make release equivalent).
#>

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$SkipTests,
  [switch]$Strict,
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$CliDir = Join-Path $RootDir "cli"

. (Join-Path $ScriptDir "local-release-version.ps1")

function Write-Step {
  param([string]$Message)
  Write-Host "[release-windows] $Message" -ForegroundColor Cyan
}

function Ensure-BuildDependencies {
  $nextBin = Join-Path $RootDir "node_modules\next"
  $esbuildBin = Join-Path $CliDir "node_modules\esbuild"
  if ((Test-Path $nextBin) -and (Test-Path $esbuildBin)) { return }

  $autoInstall = if ($env:AUTO_INSTALL_DEPS -eq "0") { $false } else { $true }
  if (-not $autoInstall) {
    throw "Build dependencies are missing. Run 'make install' first or set AUTO_INSTALL_DEPS=1."
  }

  Write-Step "Installing missing build dependencies..."
  Push-Location $RootDir
  try {
    if (-not (Test-Path $nextBin)) { npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
    if (-not (Test-Path $esbuildBin)) { npm --prefix cli install; if ($LASTEXITCODE -ne 0) { throw "npm --prefix cli install failed" } }
  } finally {
    Pop-Location
  }
}

function Invoke-Tests {
  Write-Step "Running targeted Cursor tests"
  Push-Location $RootDir
  try {
    npm exec --yes --package=vitest -- vitest run `
      tests/unit/cursor-default.test.js `
      tests/unit/cursor-composer-thinking.test.js `
      tests/unit/cursor-agent-exec-request.test.js
    if ($LASTEXITCODE -ne 0) { throw "Tests failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Invoke-Build {
  Write-Step "Building production CLI bundle ($($script:ReleaseInfo.DisplayVersion))"
  Push-Location $RootDir
  try {
    npm --prefix cli run build
    if ($LASTEXITCODE -ne 0) { throw "CLI build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is required on PATH." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required on PATH." }

$runTests = -not $SkipTests -and ($env:RUN_TESTS -ne "0")
$requireCursor = $Strict -or ($env:REQUIRE_CURSOR_CONTENT -eq "1")

$resolvedInstallDir = Get-9RouterInstallDir -InstallDir $InstallDir
$installedApp = Join-Path $resolvedInstallDir "app"
if (-not (Test-Path -LiteralPath $installedApp)) {
  throw "Installed 9Router app bundle is missing: $installedApp"
}

$script:ReleaseInfo = Prepare-LocalReleaseVersion -RootDir $RootDir -InstalledApp $installedApp

if ($DryRun) {
  Write-Step "DRY RUN - no tests, build, or deploy will run."
  Write-Step "Repository:       $RootDir"
  Write-Step "Installed bundle: $installedApp"
  Write-Step "Run tests:        $runTests"
  Write-Step "Strict Cursor probe: $requireCursor"
  Write-Step "Current patch:    $($script:ReleaseInfo.CurrentPatchNumber) (0 means unnumbered)"
  Write-Step "Next release:     $($script:ReleaseInfo.DisplayVersion)"
  & "$ScriptDir\deploy-windows.ps1" -DryRun -InstallDir $resolvedInstallDir
  exit 0
}

Ensure-BuildDependencies

if ($runTests) {
  Invoke-Tests
} else {
  Write-Step "WARNING: tests skipped"
}

Write-Step "Local release: $($script:ReleaseInfo.DisplayVersion)"
Invoke-Build

& "$ScriptDir\deploy-windows.ps1" `
  -InstallDir $resolvedInstallDir `
  -ReleaseMetadata @{
    BaseVersion     = $script:ReleaseInfo.BaseVersion
    NextPatchNumber = $script:ReleaseInfo.NextPatchNumber
    DisplayVersion  = $script:ReleaseInfo.DisplayVersion
  }

if ($requireCursor) {
  Write-Step "Strict Cursor probe is not automated on Windows yet; use macOS/Linux make release-strict for full rollback probe."
}

Write-Step "Release completed successfully"
Write-Step "Installed $($script:ReleaseInfo.DisplayVersion)"
Write-Step "Note: npm i -g 9router@latest may overwrite this patched bundle"
