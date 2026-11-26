#Requires -Version 5.1
<#
  NAT fallback for builds where ICS (HNetCfg.HNetShare) is unavailable.

  Unlike ICS this does NOT run a DHCP server. Configure the Xbox manually:
    IP      192.168.137.2
    mask    255.255.255.0
    gateway 192.168.137.1
    DNS     1.1.1.1 (or your router)

  This is still a normal Windows NAT: it removes the router from the media path
  but keeps a software forwarding hop, exactly like ICS.
#>
[CmdletBinding()]
param(
  [ValidateSet('status', 'enable', 'disable')]
  [string]$Action = 'status',

  [string]$PublicAlias = '',
  [string]$PrivateAlias = '',
  [string]$PrivateIp = '192.168.137.1',
  [string]$NatName = 'XboxLanNat'
)

$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $env:ProgramData 'XboxLanStream'
$StateFile = Join-Path $StateDir 'nat-state.json'

function Emit($value) {
  $value | ConvertTo-Json -Depth 8 -Compress
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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
    $nats = @()
    try {
      $nats = Get-NetNat -ErrorAction SilentlyContinue | Select-Object Name, InternalIPInterfaceAddressPrefix, Active
    } catch { }

    $state = $null
    if (Test-Path $StateFile) {
      try { $state = Get-Content $StateFile -Raw | ConvertFrom-Json } catch { $state = $null }
    }

    Emit @{
      ok     = $true
      admin  = (Test-Admin)
      nats   = @($nats)
      lastSetup = $state
    }
    exit 0
  }

  if (-not (Test-Admin)) {
    Emit @{ ok = $false; needAdmin = $true; error = 'Administrator rights are required to change NAT.' }
    exit 2
  }

  if ($Action -eq 'enable') {
    if ([string]::IsNullOrWhiteSpace($PublicAlias) -or [string]::IsNullOrWhiteSpace($PrivateAlias)) {
      throw 'PublicAlias and PrivateAlias are required.'
    }
    if ($PublicAlias -ieq $PrivateAlias) {
      throw 'Public and private adapters must be different.'
    }

    Set-PrivateStaticIp -Alias $PrivateAlias -Ip $PrivateIp
    Set-NetIPInterface -InterfaceAlias $PrivateAlias -Forwarding Enabled -ErrorAction Stop | Out-Null

    $prefix = '192.168.137.0/24'
    $existingNat = Get-NetNat -Name $NatName -ErrorAction SilentlyContinue
    if ($existingNat) {
      if ($existingNat.InternalIPInterfaceAddressPrefix -ne $prefix) {
        throw "NAT '$NatName' already exists with prefix $($existingNat.InternalIPInterfaceAddressPrefix)."
      }
    } else {
      New-NetNat -Name $NatName -InternalIPInterfaceAddressPrefix $prefix -ErrorAction Stop | Out-Null
    }

    Set-FirewallRules -Alias $PrivateAlias

    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    @{
      publicAlias  = $PublicAlias
      privateAlias = $PrivateAlias
      privateIp    = $PrivateIp
      natName      = $NatName
      prefix       = $prefix
      enabledAt    = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8

    Emit @{
      ok           = $true
      natName      = $NatName
      prefix       = $prefix
      privateAlias = $PrivateAlias
      privateIp    = $PrivateIp
      xboxStatic   = @{
        ip      = '192.168.137.2'
        mask    = '255.255.255.0'
        gateway = $PrivateIp
        dns     = @('1.1.1.1', '8.8.8.8')
      }
      hint         = 'Set these values in Xbox Settings > Network > Advanced settings > IP settings (Manual).'
    }
    exit 0
  }

  if ($Action -eq 'disable') {
    Remove-NetNat -Name $NatName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-FirewallRules

    if (Test-Path $StateFile) {
      try {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        if ($state.privateAlias) {
          Set-NetIPInterface -InterfaceAlias $state.privateAlias -Forwarding Disabled -ErrorAction SilentlyContinue | Out-Null
        }
        if ($state.privateIp) {
          Remove-NetIPAddress -InterfaceAlias $state.privateAlias -IPAddress $state.privateIp `
            -Confirm:$false -ErrorAction SilentlyContinue
        }
        if ($state.privateAlias) {
          Set-NetIPInterface -InterfaceAlias $state.privateAlias -Dhcp Enabled -ErrorAction SilentlyContinue | Out-Null
        }
      } catch { }
      Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
    }

    Emit @{ ok = $true; natName = $NatName; removed = $true }
    exit 0
  }
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
