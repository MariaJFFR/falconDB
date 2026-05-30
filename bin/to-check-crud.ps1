#!/usr/bin/env pwsh

Set-Location (Split-Path $PSScriptRoot)

$dns    = @('dn0s1','dn0s2','dn0s3','dn1s1','dn1s2','dn1s3','dn2s1','dn2s2','dn2s3')
$shards = @('dn0','dn1','dn2')
$dbpath = '/app/DBdata'

function Get-Files($dn) {
    (podman exec $dn sh -c "find $dbpath -name '*.json' -exec md5sum {} \; 2>/dev/null | sort") -join ' '
}

function Get-Content-All($dn) {
    (podman exec $dn sh -c "find $dbpath -name '*.json' -exec cat {} \; 2>/dev/null") -join ''
}

# detect delete
$isDelete = ($args -join ' ') -match '/db/d'

Write-Host "=== snapshot before ==="
$before = @{}
foreach ($dn in $dns) {
    $before[$dn] = Get-Files $dn
}

Write-Host ""
Write-Host "=== executing: $args ==="
$allArgs  = @($args)
$cmd      = $allArgs[0]
[array]$cmdArgs = if ($allArgs.Count -gt 1) { $allArgs[1..($allArgs.Count - 1)] } else { @() }
& $cmd @cmdArgs
Write-Host ""

Write-Host "=== snapshot after ==="
$changed = @{}
foreach ($dn in $dns) {
    $after = Get-Files $dn
    if ($before[$dn] -ne $after) {
        $changed[$dn] = $true
        Write-Host "  $dn`: CHANGED"
    } else {
        Write-Host "  $dn`: unchanged"
    }
}

Write-Host ""
Write-Host "=== consistency check per shard ==="
foreach ($shard in $shards) {
    Write-Host ""
    Write-Host "-- Shard $shard --"
    $c1 = Get-Content-All "${shard}s1"
    $c2 = Get-Content-All "${shard}s2"
    $c3 = Get-Content-All "${shard}s3"

    if ($c1 -eq $c2 -and $c2 -eq $c3) {
        Write-Host "  OK - all replicas consistent"
        if ($c1) { Write-Host "  content: $c1" }
    } else {
        Write-Host "  INCONSISTENT!"
        Write-Host "  ${shard}s1: $c1"
        Write-Host "  ${shard}s2: $c2"
        Write-Host "  ${shard}s3: $c3"
    }
}
