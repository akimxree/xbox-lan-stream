#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PublicAlias,
  [Parameter(Mandatory = $true)][string]$PrivateAlias,
  [string]$PrivateIp = '192.168.137.1'
)

& (Join-Path $PSScriptRoot 'ics.ps1') -Action enable -PublicAlias $PublicAlias -PrivateAlias $PrivateAlias -PrivateIp $PrivateIp
exit $LASTEXITCODE