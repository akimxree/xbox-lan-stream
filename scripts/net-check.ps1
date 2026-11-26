#Requires -Version 5.1
<#
  Read-only network diagnostics for a low-latency Xbox LAN setup.
  Run: powershell -ExecutionPolicy Bypass -File scripts/net-check.ps1 [-Target 192.168.1.50]
#>
[CmdletBinding()]
param(
  [string]$Target = ''
)

$ErrorActionPreference = 'Continue'

function Section($title) {
  Write-Host ''
  Write-Host "== $title ==" -ForegroundColor Green
}

Section 'Adapters'
Get-NetAdapter | Sort-Object Status, Name |
  Select-Object Name, Status, LinkSpeed, MacAddress, InterfaceDescription |
  Format-Table -AutoSize

Section 'IP configuration'
Get-NetIPConfiguration | ForEach-Object {
  [pscustomobject]@{
    Interface = $_.InterfaceAlias
    IPv4      = ($_.IPv4Address.IPAddress -join ', ')
    Gateway   = ($_.IPv4DefaultGateway.NextHop -join ', ')
    DNS       = ($_.DNSServer.ServerAddresses -join ', ')
  }
} | Format-Table -AutoSize

Section 'Default routes'
Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric |
  Select-Object InterfaceAlias, NextHop, RouteMetric, InterfaceMetric |
  Format-Table -AutoSize

Section 'Latency-relevant NIC settings'
foreach ($adapter in Get-NetAdapter | Where-Object Status -eq 'Up') {
  $props = Get-NetAdapterAdvancedProperty -Name $adapter.Name -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'Interrupt Moderation|Flow Control|Energy Efficient|Green Ethernet|Power Saving|Wake on Magic' }

  if ($props) {
    Write-Host ("-- " + $adapter.Name)
    $props | Select-Object DisplayName, DisplayValue | Format-Table -AutoSize
  }
}

Section 'Power management'
Get-NetAdapterPowerManagement -ErrorAction SilentlyContinue |
  Select-Object Name, AllowComputerToTurnOffDevice |
  Format-Table -AutoSize

Section 'Internet Connection Sharing'
$manager = New-Object -ComObject HNetCfg.HNetShare
$sharingRows = @()
foreach ($connection in $manager.EnumEveryConnection) {
  $props = $manager.NetConnectionProps($connection)
  $config = $manager.INetSharingConfigurationForINetConnection($connection)
  $type = 'none'
  if ($config.SharingEnabled) {
    if ([int]$config.SharingConnectionType -eq 0) { $type = 'public' } else { $type = 'private' }
  }
  $sharingRows += [pscustomobject]@{
    Adapter = $props.Name
    Status  = $props.Status
    Sharing = $config.SharingEnabled
    Type    = $type
  }
}
$sharingRows | Format-Table -AutoSize

if ($Target) {
  Section "ICMP to $Target"
  Test-Connection -ComputerName $Target -Count 6 -ErrorAction SilentlyContinue |
    Select-Object Address, ResponseTime, StatusCode |
    Format-Table -AutoSize
}

Section 'Recommendations'
Write-Host '- Xbox: Settings > General > Power options > Sleep (not Energy saver); Remote features enabled.'
Write-Host '- Use wired Ethernet on both ends; a gigabit switch is enough, the router is not in the media path.'
Write-Host '- Disable "Interrupt Moderation" and "Energy Efficient Ethernet" on the Xbox-facing NIC if latency is unstable.'
Write-Host '- Prefer a dedicated NIC + ICS only if the router/switch adds jitter; otherwise the L2 switch is faster than software NAT.'
Write-Host '- Make sure Windows is on the Private network profile so the firewall does not throttle WebRTC UDP.'
Write-Host ''

exit 0