<#
.SYNOPSIS
  Deploy an existing local build (cli\app) into the installed 9Router bundle.

.DESCRIPTION
  Native Windows equivalent of `make deploy`. Does not build - run
  scripts\build-windows.ps1 first if cli\app is missing. If a running
  instance is detected (CLI process or port listener), stops it, copies
  the bundle, then starts it again and waits for /v1/models health.

.PARAMETER InstallDir
  Override install directory (default: $(npm root -g)\9router).

.PARAMETER Port
  Port used to detect/stop the running server (default 20128).

.PARAMETER DryRun
  Print the deploy plan without changing anything.
#>

[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [int]$Port = 0,
  [switch]$DryRun,
  [hashtable]$ReleaseMetadata = $null
)

$ErrorActionPreference = "Stop"

if ($Port -le 0) {
  $Port = if ($env:PORT) { [int]$env:PORT } else { 20128 }
}
if (-not $InstallDir -and $env:INSTALL_DIR) {
  $InstallDir = $env:INSTALL_DIR
}
$StopTimeout = if ($env:STOP_TIMEOUT) { [int]$env:STOP_TIMEOUT } else { 20 }
$HealthTimeout = if ($env:HEALTH_TIMEOUT) { [int]$env:HEALTH_TIMEOUT } else { 45 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$SourceApp = Join-Path $RootDir "cli\app"
$SourceCli = Join-Path $RootDir "cli\cli.js"
$DataDir = Join-Path $env:USERPROFILE ".9router"

. (Join-Path $ScriptDir "local-release-version.ps1")

function Write-Step {
  param([string]$Message)
  Write-Host "[deploy-windows] $Message" -ForegroundColor Cyan
}

function Assert-BuiltBundle {
  $customServer = Join-Path $SourceApp "custom-server.js"
  if (-not (Test-Path $customServer)) {
    throw @"
No build found at cli\app.
Run 'scripts\build-windows.ps1' first (or 'make release' on macOS/Linux), then retry deploy.
"@
  }
  if (-not (Test-Path $SourceCli)) {
    throw "Missing source CLI launcher: $SourceCli"
  }
}

function Resolve-InstallDir {
  return Get-9RouterInstallDir -InstallDir $InstallDir
}

function Test-Is9RouterProcess {
  param([string]$CommandLine)

  if (-not $CommandLine) { return $false }

  $cmd = $CommandLine.ToLowerInvariant()
  if ($cmd -match 'next-server') { return $true }
  if ($cmd -match 'custom-server\.js' -and $cmd -match '9router') { return $true }
  if ($cmd -match 'node' -and $cmd -match '9router' -and ($cmd -match 'cli\.js|\\9router|/9router')) { return $true }
  return $false
}

function Get-9RouterProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { Test-Is9RouterProcess -CommandLine $_.CommandLine }
}

function Get-PortListenerPids {
  param([int]$ListenPort)

  $pids = New-Object System.Collections.Generic.List[int]
  try {
    foreach ($conn in Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue) {
      if ($conn.OwningProcess -gt 0) { $pids.Add([int]$conn.OwningProcess) | Out-Null }
    }
  } catch {
    # Fall back to netstat when Get-NetTCPConnection is unavailable.
  }

  if ($pids.Count -eq 0) {
    $matches = netstat -ano | Select-String ":$ListenPort\s" | Select-String 'LISTENING'
    foreach ($line in $matches) {
      $parts = ($line.Line.Trim() -split '\s+') | Where-Object { $_ }
      if ($parts.Count -gt 0) {
        $listenerPid = 0
        if ([int]::TryParse($parts[-1], [ref]$listenerPid) -and $listenerPid -gt 0) {
          $pids.Add($listenerPid) | Out-Null
        }
      }
    }
  }

  return @($pids | Select-Object -Unique)
}

function Test-ServiceRunning {
  param([int]$ListenPort)

  if ((Get-9RouterProcesses).Count -gt 0) { return $true }
  if ((Get-PortListenerPids -ListenPort $ListenPort).Count -gt 0) { return $true }
  return $false
}

function Wait-For9RouterExit {
  param([int]$ListenPort, [int]$TimeoutSec)

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ((Get-9RouterProcesses).Count -eq 0 -and (Get-PortListenerPids -ListenPort $ListenPort).Count -eq 0) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  Write-Step "Stopping PID $ProcessId (tree)"
  cmd /c "taskkill /T /F /PID $ProcessId >nul 2>&1"
}

function Stop-9Router {
  param([int]$ListenPort)

  $targetPids = New-Object System.Collections.Generic.List[int]
  foreach ($proc in Get-9RouterProcesses) {
    $targetPids.Add([int]$proc.ProcessId) | Out-Null
  }
  foreach ($listenerPid in Get-PortListenerPids -ListenPort $ListenPort) {
    if (-not $targetPids.Contains($listenerPid)) {
      $targetPids.Add($listenerPid) | Out-Null
    }
  }

  if ($targetPids.Count -eq 0) { return $false }

  foreach ($targetPid in $targetPids) {
    Stop-ProcessTree -ProcessId $targetPid
  }

  Start-Sleep -Seconds 2
  return $true
}

function Start-9Router {
  param([string]$InstallRoot, [string]$CliPath, [int]$ListenPort)

  $logFile = Join-Path $DataDir "log.txt"
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Write-Step "Starting: node $CliPath --tray --skip-update --port $ListenPort"
  # Start-Process cannot redirect stdout and stderr to the same file; use cmd to merge.
  $startCmd = "node `"$CliPath`" --tray --skip-update --port $ListenPort >> `"$logFile`" 2>&1"
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList @("/c", $startCmd) `
    -WorkingDirectory $InstallRoot `
    -WindowStyle Hidden | Out-Null
}

function Test-Health {
  param([int]$ListenPort, [int]$TimeoutSec = $HealthTimeout)

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$ListenPort/v1/models" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is required but was not found on PATH."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required but was not found on PATH."
}

Assert-BuiltBundle
$InstallDir = Resolve-InstallDir
$InstalledApp = Join-Path $InstallDir "app"
$InstalledCli = Join-Path $InstallDir "cli.js"

if (-not (Test-Path $InstalledCli)) { throw "Installed 9Router CLI is missing: $InstalledCli" }
if (-not (Test-Path $InstalledApp)) { throw "Installed 9Router app bundle is missing: $InstalledApp" }

$backupRoot = Join-Path $DataDir "update"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $backupRoot "manual-code-backup-$stamp"
$wasRunning = Test-ServiceRunning -ListenPort $Port

if ($DryRun) {
  Write-Step "DRY RUN - no files were copied and no processes were signalled."
  Write-Step "Source bundle:     $SourceApp"
  Write-Step "Installed bundle:  $InstalledApp"
  Write-Step "Backup directory:  $backupDir"
  Write-Step "Port:              $Port"
  Write-Step "Service running:   $wasRunning"
  if ($ReleaseMetadata) {
    Write-Step "Release metadata:  $($ReleaseMetadata.DisplayVersion)"
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

if ($wasRunning) {
  Stop-9Router -ListenPort $Port | Out-Null
  if (-not (Wait-For9RouterExit -ListenPort $Port -TimeoutSec $StopTimeout)) {
    $left = @(Get-9RouterProcesses | ForEach-Object { $_.ProcessId })
    $portLeft = Get-PortListenerPids -ListenPort $Port
    throw @"
9Router did not fully stop within ${StopTimeout}s; refusing to replace a live bundle.
Remaining PIDs: $(if ($left.Count) { $left -join ', ' } else { 'none' })
Port $Port listeners: $(if ($portLeft.Count) { $portLeft -join ', ' } else { 'none' })
"@
  }
  Write-Step "All 9Router processes stopped; port $Port is free"
}

Write-Step "Backing up installed bundle to $backupDir"
Copy-Item -Path $InstalledApp -Destination (Join-Path $backupDir "app") -Recurse -Force
Copy-Item -Path $InstalledCli -Destination (Join-Path $backupDir "cli.js") -Force

Write-Step "Deploying $SourceApp -> $InstalledApp"
Remove-Item -Path $InstalledApp -Recurse -Force
Copy-Item -Path $SourceApp -Destination $InstalledApp -Recurse -Force
Copy-Item -Path $SourceCli -Destination $InstalledCli -Force

if ($wasRunning) {
  Start-9Router -InstallRoot $InstallDir -CliPath $InstalledCli -ListenPort $Port
  if (-not (Test-Health -ListenPort $Port -TimeoutSec $HealthTimeout)) {
    throw "Server did not return HTTP 200 from /v1/models within ${HealthTimeout}s"
  }
  Write-Step "Server health check passed"
} else {
  Write-Step "No running instance detected; bundle deployed without starting it"
}

if ($ReleaseMetadata) {
  Commit-ReleaseMetadata `
    -InstalledApp $InstalledApp `
    -BaseVersion $ReleaseMetadata.BaseVersion `
    -NextPatchNumber $ReleaseMetadata.NextPatchNumber `
    -DisplayVersion $ReleaseMetadata.DisplayVersion
  Write-Step "Recorded local release metadata: $($ReleaseMetadata.DisplayVersion)"
}

Write-Step "Deploy completed successfully"
Write-Step "Backup retained at: $backupDir"
