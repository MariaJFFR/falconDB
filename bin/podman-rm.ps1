#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

Set-Location (Split-Path $PSScriptRoot)

podman rm -f --ignore `
    rp `
    dn0s1 dn0s2 dn0s3 `
    dn1s1 dn1s2 dn1s3 `
    dn2s1 dn2s2 dn2s3 `
    2>$null

exit 0
