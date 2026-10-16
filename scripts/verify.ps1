#requires -Version 5.1
<#
.SYNOPSIS
    Verificación completa de FINANZA (API + PWA): tipos, lint, pruebas y compilación.

.DESCRIPTION
    Ejecuta, en orden y sin detenerse a preguntar:
      1. API   → npm run verify   (typecheck + lint + 82 pruebas unitarias + 52 e2e + build)
      2. PWA   → npm run verify   (typecheck + lint + 29 pruebas + build de producción)

    Si algo falla, devuelve un código de salida distinto de cero y muestra qué
    paso falló. Las pruebas e2e de la API necesitan la base de datos levantada:
    el script la arranca si no está disponible.

.EXAMPLE
    .\scripts\verify.ps1
    .\scripts\verify.ps1 -SkipDb
#>
[CmdletBinding()]
param(
    [switch]$SkipDb
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$script:failed = @()
$script:started = Get-Date

function Write-Step($message) { Write-Host "`n===== $message =====" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "  OK   $message" -ForegroundColor Green }
function Write-Bad($message) { Write-Host "  FALLA $message" -ForegroundColor Red }

if (-not $SkipDb) {
    Write-Step 'Base de datos'
    $status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
    if ($status -ne 'healthy') {
        Write-Host '  Levantando el contenedor de PostgreSQL del proyecto "finanza"...'
        docker compose up -d db | Out-Host
        for ($attempt = 1; $attempt -le 30; $attempt++) {
            $status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
            if ($status -eq 'healthy') { break }
            Start-Sleep -Seconds 1
        }
    }
    if ($status -eq 'healthy') { Write-Ok 'PostgreSQL disponible' }
    else { Write-Bad 'PostgreSQL no responde'; $script:failed += 'base de datos' }

    # Las pruebas de extremo a extremo escriben movimientos de verdad: se
    # ejecutan contra su propia base de datos (finanza_test) y nunca contra la de
    # trabajo. Se prepara aquí para que la verificación sea reproducible.
    Write-Step 'Base de datos de pruebas (aislada de las cuentas reales)'
    & (Join-Path $PSScriptRoot 'create-test-db.ps1') | Select-Object -Last 6 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Bad 'No se pudo preparar la base de datos de pruebas'
        $script:failed += 'base de datos de pruebas'
    }
}

Write-Step 'API — typecheck, lint, pruebas y build'
Push-Location 'apps/api'
npm run verify
$apiExit = $LASTEXITCODE
Pop-Location
if ($apiExit -eq 0) { Write-Ok 'API verificada' } else { Write-Bad "La API falló (código $apiExit)"; $script:failed += 'API' }

Write-Step 'PWA — typecheck, lint, pruebas y build'
Push-Location 'apps/web'
npm run verify
$webExit = $LASTEXITCODE
Pop-Location
if ($webExit -eq 0) { Write-Ok 'PWA verificada' } else { Write-Bad "La PWA falló (código $webExit)"; $script:failed += 'PWA' }

$elapsed = (Get-Date) - $script:started

Write-Host ''
if ($script:failed.Count -eq 0) {
    Write-Host "VERIFICACIÓN COMPLETA: todo correcto en $([int]$elapsed.TotalSeconds) s" -ForegroundColor Green
    exit 0
}
else {
    Write-Host "VERIFICACIÓN CON FALLOS: $($script:failed -join ', ') tras $([int]$elapsed.TotalSeconds) s" -ForegroundColor Red
    exit 1
}
