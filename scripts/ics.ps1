#Requires -Version 5.1
<#
  Internet Connection Sharing helper for a dedicated PC <-> Xbox Ethernet segment.

  Actions:
    status  - JSON inventory of adapters and sharing state (no admin needed)
    enable  - share <PublicAlias> (internet) with <PrivateAlias> (Xbox), static 192.168.137.1/24
    disable - disable all sharing and restore DHCP on the private adapter

  WARNING: ICS turns the PC into a NAT router. It is only worth it when the PC
  has a second NIC and you want a physically isolated L2 segment for the stream.
#>
[CmdletBinding()]
param(
  [ValidateSet('status', 'enable', 'disable')]
  [string]$Action = 'status',

  [string]$PublicAlias = '',
  [string]$PrivateAlias = '',
  [string]$PrivateIp = '192.168.137.1'
)

$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $env:ProgramData 'XboxLanStream'
$StateFile = Join-Path $StateDir 'ics-state.json'

function Emit($value) {
  $value | ConvertTo-Json -Depth 8 -Compress
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-IcsManager {
  $manager = New-Object -ComObject HNetCfg.HNetShare
  if (-not $manager.SharingInstalled) {
    throw 'ICS provider is not available on this Windows build (HNetCfg.HNetShare.SharingInstalled = false). Use scripts/nat.ps1 as a fallback.'
  }
  if ($null -eq $manager.EnumEveryConnection) {
    throw 'ICS enumeration returned no collection. The SharedAccess service may be disabled or blocked by policy.'
  }
  return $manager
}

function Get-SharingInventory {
  $manager = New-IcsManager
  $items = New-Object System.Collections.ArrayList

  foreach ($connection in $manager.EnumEveryConnection) {
    $props = $manager.NetConnectionProps($connection)
    $config = $manager.INetSharingConfigurationForINetConnection($connection)

    $type = 'none'
    if ($config.SharingEnabled) {
      if ([int]$config.SharingConnectionType -eq 0) { $type = 'public' } else { $type = 'private' }
    }

    [void]$items.Add([pscustomobject]@{
        name           = [string]$props.Name
        device         = [string]$props.DeviceName
        status         = [string]$props.Status
        guid           = [string]$props.Guid
        sharingEnabled = [bool]$config.SharingEnabled
        sharingType    = $type
      })
  }

  return @($items)
}

function Set-PrivateStaticIp {
  param([string]$Alias, [string]$Ip)

  $existing = Get-NetIPAddress -InterfaceAlias $Alias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $Ip }

  if ($existing) { return }

  Set-NetIPInterface -InterfaceAlias $Alias -Dhcp Disabled -ErrorAction SilentlyContinue | Out-Null

  Get-NetIPAddress -InterfaceAlias $Alias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -like '169.254.*' } |
    Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue

  New-NetIPAddress -InterfaceAlias $Alias -IPAddress $Ip -PrefixLength 24 -ErrorAction Stop | Out-Null
}

function Enable-IcsSharing {
  param([string]$PublicName, [string]$PrivateName)

  $manager = New-IcsManager
  $publicConfig = $null
  $privateConfig = $null

  foreach ($connection in $manager.EnumEveryConnection) {
    $props = $manager.NetConnectionProps($connection)
    if ($props.Name -ieq $PublicName) {
      $publicConfig = $manager.INetSharingConfigurationForINetConnection($connection)
    }
    if ($props.Name -ieq $PrivateName) {
      $privateConfig = $manager.INetSharingConfigurationForINetConnection($connection)
    }
  }

  if ($null -eq $publicConfig) { throw "Public adapter not found: $PublicName" }
  if ($null -eq $privateConfig) { throw "Private adapter not found: $PrivateName" }

  if ($publicConfig.SharingEnabled) { $publicConfig.DisableSharing() }
  if ($privateConfig.SharingEnabled) { $privateConfig.DisableSharing() }

  # 0 = public, 1 = private. Public first, then private.
  $publicConfig.EnableSharing(0)
  Start-Sleep -Milliseconds 600
  $privateConfig.EnableSharing(1)

  # Keep the COM manager alive until both calls have completed.
  [void]$manager
}

function Set-FirewallRules {
  param([string]$Alias)

  $udpRule = 'Xbox LAN Stream (WebRTC UDP)'
  $icmpRule = 'Xbox LAN Stream (ICMPv4)'

  Get-NetFirewallRule -DisplayName $udpRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName $icmpRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

  New-NetFirewallRule -DisplayName $udpRule -Direction Inbound -Action Allow -Protocol UDP `
    -LocalPort 1024-65535 -InterfaceAlias $Alias -Profile Private -ErrorAction Stop | Out-Null

  New-NetFirewallRule -DisplayName $icmpRule -Direction Inbound -Action Allow -Protocol ICMPv4 `
    -InterfaceAlias $Alias -Profile Private -ErrorAction Stop | Out-Null
}

function Remove-FirewallRules {
  foreach ($name in @('Xbox LAN Stream (WebRTC UDP)', 'Xbox LAN Stream (ICMPv4)')) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  }
}

try {
  if ($Action -eq 'status') {
    $admin = Test-Admin
    $connections = @()
    $errorText = $null
    $sharingInstalled = $false

    try {
      $probe = New-Object -ComObject HNetCfg.HNetShare
      $sharingInstalled = [bool]$probe.SharingInstalled
      if ($sharingInstalled) {
        $connections = Get-SharingInventory
      }
    } catch {
      $errorText = $_.Exception.Message
    }

    $state = $null
    if (Test-Path $StateFile) {
      try { $state = Get-Content $StateFile -Raw | ConvertFrom-Json } catch { $state = $null }
    }

    if (-not $sharingInstalled -and -not $errorText) {
      $errorText = 'ICS provider is not available on this Windows build. Use scripts/nat.ps1 (NAT fallback).'
    }

    Emit @{
      ok               = ($null -eq $errorText)
      admin            = $admin
      sharingInstalled = $sharingInstalled
      error            = $errorText
      connections      = @($connections)
      lastSetup        = $state
    }
    exit 0
  }

  if (-not (Test-Admin)) {
    Emit @{ ok = $false; needAdmin = $true; error = 'Administrator rights are required to change ICS.' }
    exit 2
  }

  if ($Action -eq 'enable') {
    if ([string]::IsNullOrWhiteSpace($PublicAlias) -or [string]::IsNullOrWhiteSpace($PrivateAlias)) {
      throw 'PublicAlias and PrivateAlias are required.'
    }
    if ($PublicAlias -ieq $PrivateAlias) {
      throw 'Public and private adapters must be different.'
    }
    if ($PrivateIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
      throw "Invalid PrivateIp: $PrivateIp"
    }

    Set-PrivateStaticIp -Alias $PrivateAlias -Ip $PrivateIp
    Enable-IcsSharing -PublicName $PublicAlias -PrivateName $PrivateAlias
    Set-FirewallRules -Alias $PrivateAlias

    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    @{
      publicAlias  = $PublicAlias
      privateAlias = $PrivateAlias
      privateIp    = $PrivateIp
      enabledAt    = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8

    Emit @{
      ok          = $true
      publicAlias = $PublicAlias
      privateAlias = $PrivateAlias
      privateIp   = $PrivateIp
      firewall    = $true
      hint        = 'Connect the Xbox to the private adapter. It will get 192.168.137.x via DHCP from the PC.'
    }
    exit 0
  }

  if ($Action -eq 'disable') {
    $manager = New-IcsManager
    $disabled = New-Object System.Collections.ArrayList

    foreach ($connection in $manager.EnumEveryConnection) {
      $props = $manager.NetConnectionProps($connection)
      $config = $manager.INetSharingConfigurationForINetConnection($connection)
      if ($config.SharingEnabled) {
        $config.DisableSharing()
        [void]$disabled.Add([string]$props.Name)
      }
    }

    Remove-FirewallRules

    if (Test-Path $StateFile) {
      try {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        if ($state.privateIp) {
          Remove-NetIPAddress -InterfaceAlias $state.privateAlias -IPAddress $state.privateIp `
            -Confirm:$false -ErrorAction SilentlyContinue
        }
        if ($state.privateAlias) {
          Set-NetIPInterface -InterfaceAlias $state.privateAlias -Dhcp Enabled -ErrorAction SilentlyContinue | Out-Null
        }
      } catch {
        # best-effort cleanup
      }
      Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
    }

    Emit @{ ok = $true; disabled = @($disabled); firewall = 'removed' }
    exit 0
  }
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
