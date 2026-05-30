#!/usr/bin/env pwsh

Set-Location (Split-Path $PSScriptRoot)

$yml = 'docker-compose.yml'

Write-Host $yml

foreach ($ct in (Select-String -Path $yml -Pattern 'container_name:' | ForEach-Object { ($_.Line -split '\s+')[-1] })) {
    podman stop -t 0 $ct
}

exit 0
