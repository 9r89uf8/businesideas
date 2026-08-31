[CmdletBinding()]
param(
  [string]$RuntimeDirectory = $env:X_WEB_AUTOMATION_RUNTIME_DIR
)

$ErrorActionPreference = "Stop"

try {
  if ([string]::IsNullOrWhiteSpace($RuntimeDirectory)) {
    throw "missing runtime directory"
  }

  $localRoot = [System.IO.Path]::GetFullPath(
    [Environment]::GetFolderPath("LocalApplicationData")
  ).TrimEnd("\")
  $runtimePath = [System.IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd("\")
  $localPrefix = "$localRoot\"

  if (
    $runtimePath.StartsWith("\\") -or
    -not $runtimePath.StartsWith(
      $localPrefix,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "unsafe runtime directory"
  }

  $null = New-Item -ItemType Directory -Path $runtimePath -Force

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

  Set-Acl -LiteralPath $runtimePath -AclObject $acl

  $verified = Get-Acl -LiteralPath $runtimePath
  $rules = $verified.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  )
  foreach ($rule in $rules) {
    if (
      $rule.AccessControlType -ne
        [Security.AccessControl.AccessControlType]::Allow -or
      -not ($allowedSids -contains $rule.IdentityReference)
    ) {
      throw "runtime ACL verification failed"
    }
  }

  Write-Output "X_FOR_YOU_RUNTIME_READY"
} catch {
  Write-Error "The X collector runtime could not be provisioned securely."
  exit 1
}
