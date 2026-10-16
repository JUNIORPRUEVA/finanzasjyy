#requires -Version 5.1
<#
.SYNOPSIS
    Ejecuta las pruebas de navegador (Playwright) de la PWA de FINANZA.

.DESCRIPTION
    Antes de abrir un navegador, este script:

      1. Comprueba que PostgreSQL está levantado.
      2. Recrea la base de datos de PRUEBAS (finanza_test) y aplica migraciones.
         Las pruebas de navegador registran movimientos DE VERDAD, así que es
         imprescindible que no toquen la base de trabajo (finanza).
      3. Ejecuta Playwright, que levanta por su cuenta:
           · la API en el puerto 3310 conectada a finanza_test
           · la PWA en el puerto 5280
         Los puertos son distintos de los de desarrollo a propósito: si algo
         fallara en la configuración, no podría escribir en las cuentas reales.

    Al terminar deja:
      · apps/web/playwright-report/  → informe HTML con lo ocurrido
      · docs/capturas/<tamaño>/      → imágenes de cada pantalla

.EXAMPLE
    .\scripts\e2e-web.ps1
    .\scripts\e2e-web.ps1 -Project android-390x844 -Grep sesion
    .\scripts\e2e-web.ps1 -SoloCapturas
#>
[CmdletBinding()]
param(
    # Ejecuta sólo un perfil de dispositivo (android-390x844, iphone-375x667…).
    [string]$Project,
    # Filtra las pruebas por nombre.
    [string]$Grep,
    # Guarda únicamente las capturas de pantalla.
    [switch]$SoloCapturas
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step($message) { Write-Host "`n===== $message =====" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "  OK   $message" -ForegroundColor Green }
function Write-Bad($message) { Write-Host "  FALLA $message" -ForegroundColor Red }

$status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
if ($status -ne 'healthy') {
    Write-Host 'Levantando el contenedor de PostgreSQL...'
    docker compose up -d db | Out-Host
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        $status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
        if ($status -eq 'healthy') { break }
        Start-Sleep -Seconds 1
    }
}
if ($status -ne 'healthy') {
    Write-Bad 'PostgreSQL no responde. Pruebe: docker compose up -d db'
    exit 1
}
Write-Ok 'PostgreSQL disponible'

Write-Step 'Base de datos de pruebas (finanza_test) — la de trabajo no se toca'
& (Join-Path $PSScriptRoot 'create-test-db.ps1') | Select-Object -Last 8 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Bad 'No se pudo preparar la base de datos de pruebas'
    exit 1
}

Write-Step 'Pruebas de navegador (Playwright)'
Push-Location (Join-Path $root 'apps\web')
try {
    $arguments = @('playwright', 'test')
    if ($Project) { $arguments += @('--project', $Project) }
    if ($SoloCapturas) { $arguments += 'e2e/screenshots.spec.ts' }
    if ($Grep) { $arguments += @('--grep', $Grep) }

    & npx @arguments
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($exitCode -eq 0) {
    Write-Ok 'Todas las pruebas de navegador han pasado'
    Write-Host '  Informe:  apps\web\playwright-report\index.html'
    Write-Host '  Capturas: docs\capturas\'
} else {
    Write-Bad "Playwright devolvió el código $exitCode (vea apps\web\playwright-report)"
}
exit $exitCode
