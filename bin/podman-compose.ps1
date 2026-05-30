#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

Set-Location (Split-Path $PSScriptRoot)

if ($args.Count -eq 1) {
    podman build -t falcondb:latest -f Containerfile .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

New-Item -ItemType Directory -Force -Path logs | Out-Null
New-Item -ItemType Directory -Force -Path DBdata/dn0s1, DBdata/dn0s2, DBdata/dn0s3 | Out-Null
New-Item -ItemType Directory -Force -Path DBdata/dn1s1, DBdata/dn1s2, DBdata/dn1s3 | Out-Null
New-Item -ItemType Directory -Force -Path DBdata/dn2s1, DBdata/dn2s2, DBdata/dn2s3 | Out-Null

podman rm -f --ignore `
    rp `
    dn0s1 dn0s2 dn0s3 `
    dn1s1 dn1s2 dn1s3 `
    dn2s1 dn2s2 dn2s3 `
    2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "NEVER mind ... keep going."
}

podman compose up -d

Write-Host ""
Write-Host "falconDB running -> http://localhost:8000"
