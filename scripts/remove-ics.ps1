#Requires -Version 5.1
& (Join-Path $PSScriptRoot 'ics.ps1') -Action disable
exit $LASTEXITCODE