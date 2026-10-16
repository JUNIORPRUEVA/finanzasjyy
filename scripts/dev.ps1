#requires -Version 5.1
<#
.SYNOPSIS
    Arranca FINANZA en local: base de datos, API y PWA en tres terminales.

.DESCRIPTION
    1. Comprueba que existen los archivos .env (si no, indica cómo generarlos).
    2. Levanta sólo el contenedor de PostgreSQL del proyecto "finanza".
    3. Espera a que la base de datos esté sana.
    4. Abre dos terminales nuevas: la API (puerto 3010) y la PWA (puerto 5180).

    NUNCA toca otros contenedores: todas las órdenes usan el proyecto "finanza".

.EXAMPLE
    .\scripts\dev.ps1
    .\scripts\dev.ps1 -SkipDb
#>
[CmdletBinding()]
param(
    [switch]$SkipDb
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "    $message" -ForegroundColor Green }
function Write-Warn2($message) { Write-Host "    $message" -ForegroundColor Yellow }

Write-Step 'Comprobando la configuración'

if (-not (Test-Path '.env') -or -not (Test-Path 'apps/api/.env')) {
    Write-Warn2 'Faltan archivos .env. Ejecute primero:  .\scripts\bootstrap-dev.ps1'
    exit 1
}
Write-Ok '.env principal y apps/api/.env presentes'

if (-not (Test-Path 'apps/api/node_modules')) {
    Write-Warn2 'Faltan dependencias de la API. Ejecute: npm install --prefix apps/api'
    exit 1
}
if (-not (Test-Path 'apps/web/node_modules')) {
    Write-Warn2 'Faltan dependencias de la PWA. Ejecute: npm install --prefix apps/web'
    exit 1
}

if (-not $SkipDb) {
    Write-Step 'Levantando PostgreSQL (proyecto "finanza", contenedor finanza-postgres)'
    docker compose up -d db | Out-Host

    Write-Step 'Esperando a que la base de datos responda'
    $ready = $false
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        $status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
        if ($status -eq 'healthy') {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if ($ready) {
        Write-Ok 'Base de datos disponible en 127.0.0.1:55432'
    }
    else {
        Write-Warn2 'La base de datos no respondió a tiempo. Revise: docker compose logs db'
        exit 1
    }

    Write-Step 'Aplicando migraciones pendientes'
    Push-Location 'apps/api'
    npx prisma migrate deploy | Out-Host
    Pop-Location
    Write-Ok 'Esquema al día'
}

Write-Step 'Abriendo la API (http://localhost:3010)'
Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$root\apps\api'; Write-Host 'API FINANZA — Ctrl+C para detener' -ForegroundColor Green; npm run start:dev"
)

Write-Step 'Abriendo la PWA (http://localhost:5180)'
Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$root\apps\web'; Write-Host 'PWA FINANZA — Ctrl+C para detener' -ForegroundColor Green; npm run dev"
)

Write-Host ''
Write-Host 'FINANZA en marcha:' -ForegroundColor Green
Write-Host '  PWA            : http://localhost:5180'
Write-Host '  API            : http://localhost:3010/api/v1/health'
Write-Host '  Documentación  : http://localhost:3010/api/v1/docs'
Write-Host '  PostgreSQL     : 127.0.0.1:55432 (base de datos "finanza")'
Write-Host ''
