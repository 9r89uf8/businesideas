<#
.SYNOPSIS
Opens a short-lived, operator-only desktop for signing in to X on the pinned
Signal Foundry worker.

.DESCRIPTION
This script starts only the existing us-east-2 EC2 worker, opens a localhost
noVNC page through AWS Systems Manager, and lets the operator complete X sign-in
manually. It never reads application environment files, retrieves the X secret,
fills a form, or interacts with X page content.

The official AWS Session Manager Plugin is downloaded into a restricted local
temporary directory, its Authenticode signer and minimum supported version are
verified, and only its extracted binary is placed on PATH for this process. The
plugin is not installed on the workstation.

.NOTES
The worker image already supplies Xvfb and Google Chrome. If any of x11vnc,
novnc, or websockify is absent, the remote command installs only the missing
names and purges only those same top-level packages during cleanup. It never
runs autoremove.

The helper never opens an EC2 ingress rule. Xvfb has TCP disabled; x11vnc and
noVNC listen only on 127.0.0.1 and are reachable only through the temporary SSM
port-forwarding session. The interactive desktop is capped at 15 minutes, with
a 20-minute guest shutdown lease and the worker's independent boot auto-stop as
backstops. Run this command only when no research run is active; it also refuses
to begin unless the pinned worker is stopped.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Region = "us-east-2"
$InstanceId = "i-064c47109859601d1"
$WorkerUser = "signal-foundry-x"
$RuntimeDirectory = "/var/lib/signal-foundry/x-for-you"
$ChromeProfileDirectory = "/var/lib/signal-foundry/x-for-you/chrome-profile"
$ProfileLockFile = "/var/lib/signal-foundry/x-for-you/locks/chrome-profile.lock"
$RemoteDisplay = ":97"
$RemoteVncPort = 5997
$RemoteNoVncPort = 6080
$MaxSessionSeconds = 900
$ShutdownLeaseMinutes = 20
$SessionId = [Guid]::NewGuid().ToString("N")
$RemoteStateDirectory = "/run/signal-foundry-x-login-$SessionId"
$RemoteStopFile = "$RemoteStateDirectory/stop"
$RemoteReadyFile = "$RemoteStateDirectory/ready"

$OfficialPluginUrl =
  "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/windows/SessionManagerPlugin.zip"
$MinimumPluginVersion = [Version]"1.2.764.0"

$script:AwsExecutable = $null
$script:TemporaryDirectory = $null
$script:RunCommandFileCounter = 0

function New-RestrictedTemporaryDirectory {
  param([Parameter(Mandatory = $true)][string]$Name)

  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\")
  if ($Name -notmatch '^signal-foundry-x-login-[a-f0-9]{32}$') {
    throw "INVALID_TEMPORARY_DIRECTORY"
  }

  $path = Join-Path $temporaryRoot $Name
  $null = New-Item -ItemType Directory -Path $path -Force
  $script:TemporaryDirectory = $path

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [Security.Principal.SecurityIdentifier]::new(
    [Security.Principal.WellKnownSidType]::LocalSystemSid,
    $null
  )
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new(
    [Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
    $null
  )
  $allowedSids = @($currentSid, $systemSid, $administratorsSid)
  $inheritance =
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($currentSid)
  $acl.SetAccessRuleProtection($true, $false)

  foreach ($sid in $allowedSids) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $null = $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl

  return $path
}

function Remove-RestrictedTemporaryDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\")
  $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  $parent = [IO.Directory]::GetParent($resolvedPath)
  $leaf = [IO.Path]::GetFileName($resolvedPath)
  if (
    $null -eq $parent -or
    -not $parent.FullName.Equals(
      $temporaryRoot,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $leaf -notmatch '^signal-foundry-x-login-[a-f0-9]{32}$'
  ) {
    throw "UNSAFE_TEMPORARY_CLEANUP"
  }

  Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Invoke-AwsCommand {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AsJson
  )

  if ([string]::IsNullOrWhiteSpace($script:AwsExecutable)) {
    throw "AWS_CLI_UNAVAILABLE"
  }

  $fullArguments = @($Arguments) + @(
    "--region", $Region,
    "--no-cli-pager"
  )
  if ($AsJson) {
    $fullArguments += @("--output", "json")
  }

  $captured = @(& $script:AwsExecutable @fullArguments 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "AWS_COMMAND_FAILED"
  }

  if (-not $AsJson) {
    return
  }

  $text = ($captured | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  try {
    return $text | ConvertFrom-Json
  } catch {
    throw "AWS_RESPONSE_INVALID"
  }
}

function Write-PrivateJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  $json = $Value | ConvertTo-Json -Depth 8 -Compress
  [IO.File]::WriteAllText(
    $Path,
    $json,
    [Text.UTF8Encoding]::new($false)
  )
}

function Send-RemoteShellCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [ValidateRange(30, 1200)][int]$ExecutionTimeoutSeconds = 120
  )

  $script:RunCommandFileCounter += 1
  $parameterFile = Join-Path $script:TemporaryDirectory (
    "run-command-{0}.json" -f $script:RunCommandFileCounter
  )
  $normalizedCommand = $Command.Replace("`r`n", "`n").Replace("`r", "`n")
  Write-PrivateJsonFile -Path $parameterFile -Value @{
    commands = @($normalizedCommand)
    executionTimeout = @([string]$ExecutionTimeoutSeconds)
  }

  $response = Invoke-AwsCommand -AsJson -Arguments @(
    "ssm", "send-command",
    "--instance-ids", $InstanceId,
    "--document-name", "AWS-RunShellScript",
    "--comment", "Signal Foundry operator-only X login",
    "--parameters", "file://$parameterFile",
    "--timeout-seconds", "60"
  )
  $commandId = [string]$response.Command.CommandId
  if ($commandId -notmatch '^[0-9a-fA-F-]{36}$') {
    throw "SSM_COMMAND_ID_INVALID"
  }
  return $commandId
}

function Wait-RemoteShellCommand {
  param(
    [Parameter(Mandatory = $true)][string]$CommandId,
    [ValidateRange(10, 1200)][int]$TimeoutSeconds = 120
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lookupFailures = 0
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $invocation = Invoke-AwsCommand -AsJson -Arguments @(
        "ssm", "get-command-invocation",
        "--command-id", $CommandId,
        "--instance-id", $InstanceId
      )
      $lookupFailures = 0
      $status = [string]$invocation.Status
      if ($status -in @("Success", "Cancelled", "TimedOut", "Failed")) {
        return $status
      }
    } catch {
      $lookupFailures += 1
      if ($lookupFailures -gt 5) {
        throw "SSM_COMMAND_STATUS_UNAVAILABLE"
      }
    }
    Start-Sleep -Seconds 2
  }
  throw "SSM_COMMAND_WAIT_TIMEOUT"
}

function Wait-ForSsmOnline {
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-AwsCommand -AsJson -Arguments @(
        "ssm", "describe-instance-information",
        "--filters", "Key=InstanceIds,Values=$InstanceId"
      )
      $online = @($response.InstanceInformationList) | Where-Object {
        $_.InstanceId -eq $InstanceId -and $_.PingStatus -eq "Online"
      }
      if ($online.Count -eq 1) {
        return
      }
    } catch {
      # A newly booted SSM agent can be temporarily absent from the response.
    }
    Start-Sleep -Seconds 5
  }
  throw "SSM_NOT_ONLINE"
}

function Get-PinnedInstanceState {
  $response = Invoke-AwsCommand -AsJson -Arguments @(
    "ec2", "describe-instances",
    "--instance-ids", $InstanceId
  )
  $instances = @(
    $response.Reservations |
      ForEach-Object { $_.Instances } |
      Where-Object { $_.InstanceId -eq $InstanceId }
  )
  if ($instances.Count -ne 1) {
    throw "PINNED_INSTANCE_UNAVAILABLE"
  }
  return [string]$instances[0].State.Name
}

function Get-FreeLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Test-LoopbackPort {
  param([Parameter(Mandatory = $true)][int]$Port)

  $client = [Net.Sockets.TcpClient]::new()
  try {
    $attempt = $client.BeginConnect([Net.IPAddress]::Loopback, $Port, $null, $null)
    if (-not $attempt.AsyncWaitHandle.WaitOne(500)) {
      return $false
    }
    $client.EndConnect($attempt)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Stop-ExactProcessTree {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

  if ($Process.HasExited) {
    return
  }
  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  $captured = @(& $taskkill /PID ([string]$Process.Id) /T /F 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $Process.Refresh()
    if (-not $Process.HasExited) {
      throw "PROCESS_TREE_CLEANUP_FAILED"
    }
  }
  $null = $Process.WaitForExit(5000)
}

function ConvertTo-PowerShellSingleQuotedLiteral {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Install-TemporarySessionManagerPlugin {
  $outerZip = Join-Path $script:TemporaryDirectory "session-manager-plugin.zip"
  $outerDirectory = Join-Path $script:TemporaryDirectory "aws-package"
  $pluginDirectory = Join-Path $script:TemporaryDirectory "session-manager-plugin"

  Invoke-WebRequest -UseBasicParsing -Uri $OfficialPluginUrl -OutFile $outerZip
  Expand-Archive -LiteralPath $outerZip -DestinationPath $outerDirectory -Force
  $innerZip = Join-Path $outerDirectory "package.zip"
  if (-not (Test-Path -LiteralPath $innerZip -PathType Leaf)) {
    throw "PLUGIN_PACKAGE_INVALID"
  }
  Expand-Archive -LiteralPath $innerZip -DestinationPath $pluginDirectory -Force

  $pluginExecutable = Join-Path (
    Join-Path $pluginDirectory "bin"
  ) "session-manager-plugin.exe"
  if (-not (Test-Path -LiteralPath $pluginExecutable -PathType Leaf)) {
    throw "PLUGIN_PACKAGE_INVALID"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $pluginExecutable
  $signerName = $null
  if ($null -ne $signature.SignerCertificate) {
    $signerName = $signature.SignerCertificate.GetNameInfo(
      [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
      $false
    )
  }
  if (
    $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    $signerName -ne "Amazon Web Services, Inc."
  ) {
    throw "PLUGIN_SIGNATURE_INVALID"
  }

  $versionOutput = @(& $pluginExecutable --version 2>&1)
  if ($LASTEXITCODE -ne 0 -or $versionOutput.Count -ne 1) {
    throw "PLUGIN_VERSION_INVALID"
  }
  try {
    $pluginVersion = [Version]([string]$versionOutput[0]).Trim()
  } catch {
    throw "PLUGIN_VERSION_INVALID"
  }
  if ($pluginVersion -lt $MinimumPluginVersion) {
    throw "PLUGIN_VERSION_UNSUPPORTED"
  }

  return (Split-Path -Parent $pluginExecutable)
}

function New-RemotePreflightScript {
  return @"
set -eu
set +x
test "`$(id -u)" -eq 0
id '$WorkerUser' >/dev/null 2>&1
test -x /usr/bin/Xvfb
test -x /usr/bin/google-chrome
test -x /usr/bin/systemd-run
test -x /usr/bin/systemctl
test -x /usr/bin/apt-get
test -x /usr/bin/dpkg-query
test -x /usr/bin/grep
test -x /usr/sbin/runuser
test -x /usr/sbin/shutdown
test -d '$RuntimeDirectory'
"@
}

function New-RemoteDesktopScript {
  $lockOwnerToken = "manual-login-$SessionId"
  return @"
exec /usr/bin/bash <<'SIGNAL_FOUNDRY_X_LOGIN'
#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly worker_user='$WorkerUser'
readonly runtime_directory='$RuntimeDirectory'
readonly profile_directory='$ChromeProfileDirectory'
readonly profile_lock='$ProfileLockFile'
readonly lock_owner_token='$lockOwnerToken'
readonly lock_payload='{"version":1,"ownerToken":"$lockOwnerToken","processId":null,"acquiredAt":"operator-session"}'
readonly state_directory='$RemoteStateDirectory'
readonly stop_file='$RemoteStopFile'
readonly ready_file='$RemoteReadyFile'
readonly display_number='$RemoteDisplay'
readonly vnc_port='$RemoteVncPort'
readonly novnc_port='$RemoteNoVncPort'
readonly session_seconds='$MaxSessionSeconds'
readonly shutdown_lease_minutes='$ShutdownLeaseMinutes'
readonly unit_prefix='signal-foundry-x-login-$SessionId'
readonly xvfb_unit="`${unit_prefix}-xvfb.service"
readonly chrome_unit="`${unit_prefix}-chrome.service"
readonly vnc_unit="`${unit_prefix}-vnc.service"
readonly novnc_unit="`${unit_prefix}-novnc.service"
lock_owned=0
temporary_packages=''

cleanup() {
  cleanup_status=0
  /usr/bin/systemctl stop "`${novnc_unit}" >/dev/null 2>&1 || true
  /usr/bin/systemctl stop "`${vnc_unit}" >/dev/null 2>&1 || true
  /usr/bin/systemctl stop "`${chrome_unit}" >/dev/null 2>&1 || true
  /usr/bin/systemctl stop "`${xvfb_unit}" >/dev/null 2>&1 || true

  if [[ -n "`${temporary_packages}" ]]; then
    DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get purge -y \
      `${temporary_packages} >/dev/null 2>&1 || cleanup_status=1
  fi
  if [[ "`${lock_owned}" -eq 1 ]] && [[ -f "`${profile_lock}" ]]; then
    actual_lock_payload="`$(/usr/bin/cat -- "`${profile_lock}" 2>/dev/null || true)"
    if [[ "`${actual_lock_payload}" == "`${lock_payload}" ]]; then
      /usr/bin/rm -f -- "`${profile_lock}" || cleanup_status=1
    else
      cleanup_status=1
    fi
  fi
  /usr/bin/rm -rf -- "`${state_directory}" || cleanup_status=1
  return "`${cleanup_status}"
}

wait_for_unit() {
  for _ in {1..40}; do
    /usr/bin/systemctl is-active --quiet "`$1" && return 0
    /usr/bin/sleep 0.25
  done
  return 1
}
trap 'cleanup || true' EXIT
trap 'exit 130' INT TERM HUP

/usr/sbin/shutdown -h +"`${shutdown_lease_minutes}" >/dev/null 2>&1 || true
/usr/bin/install -d -m 0700 "`${state_directory}"
/usr/bin/install -d -o "`${worker_user}" -g "`${worker_user}" -m 0700 \
  "`${profile_directory}" "`$(/usr/bin/dirname -- "`${profile_lock}")"

if /usr/bin/pgrep -u "`${worker_user}" -f -- \
  "--user-data-dir=`${profile_directory}" >/dev/null 2>&1; then
  exit 20
fi
if ! (set -o noclobber; /usr/bin/printf '%s\n' "`${lock_payload}" > "`${profile_lock}") 2>/dev/null; then
  exit 21
fi
lock_owned=1
/usr/bin/chown "`${worker_user}:`${worker_user}" "`${profile_lock}"
/usr/bin/chmod 0600 "`${profile_lock}"

for package_name in x11vnc novnc websockify; do
  if ! /usr/bin/dpkg-query -W -f='`${db:Status-Abbrev}' \
    "`${package_name}" 2>/dev/null | /usr/bin/grep -q '^ii '; then
    temporary_packages="`${temporary_packages} `${package_name}"
  fi
done
if [[ -n "`${temporary_packages}" ]]; then
  /usr/bin/apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y \
    --no-install-recommends `${temporary_packages} >/dev/null
fi
test -x /usr/bin/x11vnc
test -x /usr/bin/websockify
test -r /usr/share/novnc/vnc.html

/usr/bin/systemd-run --quiet --collect --unit="`${xvfb_unit}" \
  --uid="`${worker_user}" --property=Type=exec --property=KillMode=control-group \
  --property=TimeoutStopSec=10s \
  /usr/bin/Xvfb "`${display_number}" -screen 0 1280x900x24 -nolisten tcp
wait_for_unit "`${xvfb_unit}"

/usr/bin/systemd-run --quiet --collect --unit="`${chrome_unit}" \
  --uid="`${worker_user}" --property=Type=exec --property=KillMode=control-group \
  --property=TimeoutStopSec=15s \
  --setenv="HOME=/var/lib/`${worker_user}" --setenv="DISPLAY=`${display_number}" \
  /usr/bin/google-chrome \
  --user-data-dir="`${profile_directory}" \
  --no-first-run --no-default-browser-check --disable-background-mode \
  'https://x.com/i/flow/login'

/usr/bin/systemd-run --quiet --collect --unit="`${vnc_unit}" \
  --uid="`${worker_user}" --property=Type=exec --property=KillMode=control-group \
  --property=TimeoutStopSec=5s --setenv="DISPLAY=`${display_number}" \
  /usr/bin/x11vnc -display "`${display_number}" -localhost -nopw -forever \
  -shared -noclipboard -nosetclipboard -rfbport "`${vnc_port}"

/usr/bin/systemd-run --quiet --collect --unit="`${novnc_unit}" \
  --uid="`${worker_user}" --property=Type=exec --property=KillMode=control-group \
  --property=TimeoutStopSec=5s \
  /usr/bin/websockify --web=/usr/share/novnc \
  "127.0.0.1:`${novnc_port}" "127.0.0.1:`${vnc_port}"

wait_for_unit "`${chrome_unit}"
wait_for_unit "`${vnc_unit}"
wait_for_unit "`${novnc_unit}"

for _ in {1..40}; do
  if /usr/bin/curl -fsS --max-time 1 \
    "http://127.0.0.1:`${novnc_port}/vnc.html" >/dev/null 2>&1; then
    /usr/bin/touch "`${ready_file}"
    break
  fi
  /usr/bin/sleep 0.25
done
test -f "`${ready_file}"

deadline=`$((SECONDS + session_seconds))
while (( SECONDS < deadline )); do
  [[ ! -e "`${stop_file}" ]] || break
  /usr/bin/systemctl is-active --quiet "`${chrome_unit}" || break
  /usr/bin/sleep 2
done

trap - EXIT INT TERM HUP
cleanup
SIGNAL_FOUNDRY_X_LOGIN
"@
}

function New-RemoteReadinessScript {
  return @"
set -eu
set +x
for _ in `$(seq 1 45); do
  test -f '$RemoteReadyFile' && exit 0
  sleep 2
done
exit 1
"@
}

function New-RemoteStopScript {
  return @"
set -eu
set +x
if test -d '$RemoteStateDirectory'; then
  touch '$RemoteStopFile'
fi
"@
}

function Start-LocalPortForward {
  param(
    [Parameter(Mandatory = $true)][int]$LocalPort,
    [Parameter(Mandatory = $true)][string]$PluginBinDirectory
  )

  $parametersFile = Join-Path $script:TemporaryDirectory "port-forward.json"
  Write-PrivateJsonFile -Path $parametersFile -Value @{
    portNumber = @([string]$RemoteNoVncPort)
    localPortNumber = @([string]$LocalPort)
  }

  $launcherPath = Join-Path $script:TemporaryDirectory "start-port-forward.ps1"
  $awsLiteral = ConvertTo-PowerShellSingleQuotedLiteral $script:AwsExecutable
  $pluginLiteral = ConvertTo-PowerShellSingleQuotedLiteral $PluginBinDirectory
  $parametersLiteral = ConvertTo-PowerShellSingleQuotedLiteral (
    "file://$parametersFile"
  )
  $launcher = @"
`$ErrorActionPreference = 'Stop'
`$env:PATH = $pluginLiteral + ';' + `$env:PATH
& $awsLiteral ssm start-session --target '$InstanceId' --document-name 'AWS-StartPortForwardingSession' --parameters $parametersLiteral --region '$Region' --no-cli-pager
exit `$LASTEXITCODE
"@
  Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding UTF8

  $stdoutPath = Join-Path $script:TemporaryDirectory "port-forward.stdout.log"
  $stderrPath = Join-Path $script:TemporaryDirectory "port-forward.stderr.log"
  $windowsPowerShell = Join-Path $env:SystemRoot (
    "System32\WindowsPowerShell\v1.0\powershell.exe"
  )
  $argumentLine = (
    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f
      $launcherPath.Replace('"', '""')
  )
  $startProcessParameters = @{
    FilePath = $windowsPowerShell
    ArgumentList = $argumentLine
    WindowStyle = "Hidden"
    PassThru = $true
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
  }
  return Start-Process @startProcessParameters
}

$instanceMustBeStopped = $false
$mainCommandId = $null
$tunnelProcess = $null
$savedPath = $env:PATH
$savedAwsPager = $env:AWS_PAGER
$failureCode = $null
$cleanupFailed = $false

try {
  if ($env:OS -ne "Windows_NT") {
    throw "WINDOWS_REQUIRED"
  }
  $awsCommand = Get-Command "aws.exe" -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  $script:AwsExecutable = [string]$awsCommand.Source
  if ([string]::IsNullOrWhiteSpace($script:AwsExecutable)) {
    throw "AWS_CLI_UNAVAILABLE"
  }

  $script:TemporaryDirectory = New-RestrictedTemporaryDirectory -Name (
    "signal-foundry-x-login-$SessionId"
  )
  $pluginBinDirectory = Install-TemporarySessionManagerPlugin
  $env:PATH = "$pluginBinDirectory;$savedPath"
  $env:AWS_PAGER = ""

  $initialState = Get-PinnedInstanceState
  if ($initialState -ne "stopped") {
    throw "WORKER_NOT_STOPPED"
  }

  # Set this before StartInstances: even a lost CLI response can follow a
  # successful API mutation, so finally must still request the pinned stop.
  $instanceMustBeStopped = $true
  $startResponse = Invoke-AwsCommand -AsJson -Arguments @(
    "ec2", "start-instances",
    "--instance-ids", $InstanceId
  )
  $startedInstances = @($startResponse.StartingInstances)
  if (
    $startedInstances.Count -ne 1 -or
    $startedInstances[0].InstanceId -ne $InstanceId -or
    $startedInstances[0].PreviousState.Name -ne "stopped"
  ) {
    throw "WORKER_START_STATE_INVALID"
  }

  Invoke-AwsCommand -Arguments @(
    "ec2", "wait", "instance-running",
    "--instance-ids", $InstanceId
  )
  Wait-ForSsmOnline

  $preflightCommandId = Send-RemoteShellCommand `
    -Command (New-RemotePreflightScript) -ExecutionTimeoutSeconds 60
  $preflightStatus = Wait-RemoteShellCommand `
    -CommandId $preflightCommandId -TimeoutSeconds 90
  if ($preflightStatus -ne "Success") {
    throw "REMOTE_BASE_COMPONENT_MISSING"
  }

  $mainCommandId = Send-RemoteShellCommand `
    -Command (New-RemoteDesktopScript) `
    -ExecutionTimeoutSeconds 1200
  $readinessCommandId = Send-RemoteShellCommand `
    -Command (New-RemoteReadinessScript) -ExecutionTimeoutSeconds 120
  $readinessStatus = Wait-RemoteShellCommand `
    -CommandId $readinessCommandId -TimeoutSeconds 130
  if ($readinessStatus -ne "Success") {
    throw "REMOTE_DESKTOP_NOT_READY"
  }

  $localPort = Get-FreeLoopbackPort
  $tunnelProcess = Start-LocalPortForward `
    -LocalPort $localPort -PluginBinDirectory $pluginBinDirectory
  $portDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $portDeadline) {
    if ($tunnelProcess.HasExited) {
      throw "SSM_TUNNEL_FAILED"
    }
    if (Test-LoopbackPort -Port $localPort) {
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-LoopbackPort -Port $localPort)) {
    throw "SSM_TUNNEL_NOT_READY"
  }

  $operatorUrl =
    "http://127.0.0.1:$localPort/vnc.html?autoconnect=1&resize=scale"
  Start-Process -FilePath $operatorUrl | Out-Null

  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.Application]::EnableVisualStyles()
  $null = [Windows.Forms.MessageBox]::Show(
    "Complete X sign-in in the browser window. If X asks for a phone code, choose 'Use password' instead. Click OK only after the X home timeline is visible.",
    "Signal Foundry - X sign-in",
    [Windows.Forms.MessageBoxButtons]::OK,
    [Windows.Forms.MessageBoxIcon]::Information
  )
} catch {
  $failureCode = [string]$_.Exception.Message
} finally {
  if ($null -ne $mainCommandId -and $instanceMustBeStopped) {
    try {
      $stopCommandId = Send-RemoteShellCommand `
        -Command (New-RemoteStopScript) -ExecutionTimeoutSeconds 60
      $null = Wait-RemoteShellCommand `
        -CommandId $stopCommandId -TimeoutSeconds 45
      $mainCleanupStatus = Wait-RemoteShellCommand `
        -CommandId $mainCommandId -TimeoutSeconds 120
      if ($mainCleanupStatus -ne "Success") {
        $cleanupFailed = $true
      }
    } catch {
      $cleanupFailed = $true
    }
  }

  if ($null -ne $tunnelProcess) {
    try {
      Stop-ExactProcessTree -Process $tunnelProcess
    } catch {
      $cleanupFailed = $true
    }
  }

  if ($instanceMustBeStopped -and $null -ne $script:AwsExecutable) {
    try {
      Invoke-AwsCommand -Arguments @(
        "ec2", "stop-instances",
        "--instance-ids", $InstanceId
      )
      Invoke-AwsCommand -Arguments @(
        "ec2", "wait", "instance-stopped",
        "--instance-ids", $InstanceId
      )
    } catch {
      $cleanupFailed = $true
    }
  }

  $env:PATH = $savedPath
  $env:AWS_PAGER = $savedAwsPager
  if ($null -ne $script:TemporaryDirectory) {
    try {
      Remove-RestrictedTemporaryDirectory -Path $script:TemporaryDirectory
    } catch {
      $cleanupFailed = $true
    }
  }
}

if ($null -ne $failureCode) {
  if ($failureCode -eq "WORKER_NOT_STOPPED") {
    [Console]::Error.WriteLine(
      "The X worker is already active. Wait for it to stop before opening a manual sign-in session."
    )
  } elseif ($failureCode -eq "REMOTE_BASE_COMPONENT_MISSING") {
    [Console]::Error.WriteLine(
      "The worker image is missing a required base component and needs maintenance."
    )
  } else {
    [Console]::Error.WriteLine(
      "The manual X sign-in session could not be completed safely."
    )
  }
  exit 1
}
if ($cleanupFailed) {
  [Console]::Error.WriteLine(
    "The sign-in window closed, but cleanup could not be fully confirmed; the cloud shutdown lease remains active."
  )
  exit 1
}

Write-Output "X_FOR_YOU_MANUAL_LOGIN_COMPLETE"
