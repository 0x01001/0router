<#
.SYNOPSIS
  Shared local release patch counter helpers (Windows parity with release-local.sh).
#>

$script:LocalReleaseFileName = ".local-release.json"

function Get-9RouterInstallDir {
  param(
    [string]$InstallDir = ""
  )

  if ($InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
    return (Resolve-Path -LiteralPath $InstallDir).Path
  }

  if ($env:INSTALL_DIR -and (Test-Path -LiteralPath $env:INSTALL_DIR)) {
    return (Resolve-Path -LiteralPath $env:INSTALL_DIR).Path
  }

  $npmRoot = (& npm root -g 2>$null).Trim()
  if ($npmRoot) {
    $candidate = Join-Path $npmRoot "9router"
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "Installed 9Router not found. Pass -InstallDir or run: npm i -g 9router"
}

function Read-PackageVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir
  )

  $packageJson = Join-Path $RootDir "package.json"
  if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "Missing root package.json: $packageJson"
  }

  $version = & node -e @"
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) process.exit(1);
process.stdout.write(pkg.version);
"@ $packageJson

  if ($LASTEXITCODE -ne 0 -or -not $version) {
    throw "Could not read a valid semantic version from $packageJson"
  }

  return $version.Trim()
}

function Read-InstalledPatchNumber {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstalledApp,
    [Parameter(Mandatory = $true)]
    [string]$BaseVersion
  )

  $marker = Join-Path $InstalledApp $script:LocalReleaseFileName
  if (-not (Test-Path -LiteralPath $marker)) {
    return 0
  }

  $patch = & node -e @"
const fs = require('fs');
try {
  const marker = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const expectedVersion = process.argv[2];
  const patch = marker.patchNumber;
  process.stdout.write(
    marker.version === expectedVersion && Number.isSafeInteger(patch) && patch > 0
      ? String(patch)
      : '0'
  );
} catch {
  process.stdout.write('0');
}
"@ $marker $BaseVersion

  if ($patch -notmatch '^\d+$') {
    throw "Invalid installed local patch number: $patch"
  }

  return [int]$patch
}

function Prepare-LocalReleaseVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir,
    [Parameter(Mandatory = $true)]
    [string]$InstalledApp
  )

  $baseVersion = Read-PackageVersion -RootDir $RootDir
  $currentPatchNumber = Read-InstalledPatchNumber -InstalledApp $InstalledApp -BaseVersion $baseVersion
  $nextPatchNumber = $currentPatchNumber + 1
  $displayVersion = "v$baseVersion patch #$nextPatchNumber"

  $env:NEXT_PUBLIC_LOCAL_PATCH_NUMBER = [string]$nextPatchNumber

  return [PSCustomObject]@{
    BaseVersion         = $baseVersion
    CurrentPatchNumber  = $currentPatchNumber
    NextPatchNumber     = $nextPatchNumber
    DisplayVersion      = $displayVersion
  }
}

function Commit-ReleaseMetadata {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstalledApp,
    [Parameter(Mandatory = $true)]
    [string]$BaseVersion,
    [Parameter(Mandatory = $true)]
    [int]$NextPatchNumber,
    [Parameter(Mandatory = $true)]
    [string]$DisplayVersion
  )

  $marker = Join-Path $InstalledApp $script:LocalReleaseFileName
  $releasedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $payload = [ordered]@{
    version        = $BaseVersion
    patchNumber    = $NextPatchNumber
    displayVersion = $DisplayVersion
    releasedAt     = $releasedAt
  } | ConvertTo-Json -Depth 3

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($marker, "$payload`n", $utf8NoBom)
}
