#Requires -Version 5.1
<#
  Best-effort NIC tuning for stable frame pacing.

  Disables Interrupt Moderation / EEE / Green Ethernet / NIC power saving on the
  Xbox-facing adapter. Every changed value is saved and can be restored with
  -Revert. Use the adapter that is physically connected to the console.

  Example:
    powershell -ExecutionPolicy Bypass -File scripts/tune-nic.ps1 -Alias "Ethernet 2"
    powershell -ExecutionPolicy Bypass -File scripts/tune-nic.ps1 -Alias "Ethernet 2" -Revert
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Alias,
  [switch]$Revert
)

$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $env:ProgramData 'XboxLanStream'
$safe = ($Alias -replace '[^\w\-]', '_')
$StateFile = Join-Path $StateDir ("nic-$safe.json")

function Emit($value) {
  $value | ConvertTo-Json -Depth 8 -Compress
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Emit @{ ok = $false; needAdmin = $true; error = 'Administrator rights are required.' }
  exit 2
}

$patterns = @(
  'Interrupt Moderation',
  'Energy Efficient Ethernet',
  'Green Ethernet',
  'Ultra Low Power',
  'Power Saving Mode',
  'Flow Control'
)

try {
  $adapter = Get-NetAdapter -Name $Alias -ErrorAction Stop

  if ($Revert) {
    if (-not (Test-Path $StateFile)) {
      Emit @{ ok = $false; error = 'No saved state for this adapter.' }
      exit 1
    }
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    foreach ($item in @($state.properties)) {
      try {
        Set-NetAdapterAdvancedProperty -Name $Alias -DisplayName $item.name -DisplayValue $item.value -ErrorAction Stop | Out-Null
      } catch { }
    }
    try {
      Set-NetAdapterPowerManagement -Name $Alias -AllowComputerToTurnOffDevice $state.power -ErrorAction Stop | Out-Null
    } catch { }
    Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
    Emit @{ ok = $true; reverted = $true; adapter = $Alias }
    exit 0
  }

  $props = Get-NetAdapterAdvancedProperty -Name $Alias -ErrorAction Stop |
    Where-Object {
      $name = $_.DisplayName
      ($patterns | Where-Object { $name -like "*$_*" }).Count -gt 0
    }

  $saved = @()
  $changed = @()
  foreach ($prop in $props) {
    $saved += [pscustomobject]@{ name = $prop.DisplayName; value = $prop.DisplayValue }
    $targets = @('Disabled', 'Off', '0')
    $done = $false
    foreach ($target in $targets) {
      try {
        Set-NetAdapterAdvancedProperty -Name $Alias -DisplayName $prop.DisplayName -DisplayValue $target -ErrorAction Stop | Out-Null
        $changed += [pscustomobject]@{ name = $prop.DisplayName; from = $prop.DisplayValue; to = $target }
        $done = $true
        break
      } catch { }
    }
    if (-not $done) {
      $changed += [pscustomobject]@{ name = $prop.DisplayName; from = $prop.DisplayValue; to = 'unchanged' }
    }
  }

  $powerBefore = $null
  try {
    $pm = Get-NetAdapterPowerManagement -Name $Alias -ErrorAction Stop
    $powerBefore = $pm.AllowComputerToTurnOffDevice
    Set-NetAdapterPowerManagement -Name $Alias -AllowComputerToTurnOffDevice Disabled -ErrorAction Stop | Out-Null
  } catch { }

  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  @{
    adapter       = $Alias
    properties    = @($saved)
    power         = $powerBefore
    tunedAt       = (Get-Date).ToString('o')
  } | ConvertTo-Json -Depth 6 | Set-Content -Path $StateFile -Encoding UTF8

  Emit @{
    ok      = $true
    adapter = $Alias
    changed = @($changed)
    state   = $StateFile
    hint    = 'Reboot or disable/enable the adapter for every setting to take effect.'
  }
  exit 0
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
  exit 1
}