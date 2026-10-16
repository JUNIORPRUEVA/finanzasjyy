#requires -Version 5.1
<#
.SYNOPSIS
  Prepara FINANZA en local: genera secretos, crea los .env, levanta PostgreSQL aislado
  e instala dependencias.

.DESCRIPTION
  Es idempotente: NUNCA sobrescribe un .env existente (para no perder secretos ya generados).
  Usa contenedor/volumen/puerto exclusivos de FINANZA (finanza-postgres / finanza_pgdata / 55432)
  para no interferir con otros proyectos de la máquina.

.EXAMPLE
  pwsh -File scripts/bootstrap-dev.ps1
  pwsh -File scripts/bootstrap-dev.ps1 -SkipInstall
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipDb
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$apiEnvFile = Join-Path $root 'apps\api\.env'
$webEnvFile = Join-Path $root 'apps\web\.env'

function New-Secret {
    param([int]$Bytes = 48)
    return (node -e "console.log(require('crypto').randomBytes($Bytes).toString('base64url'))").Trim()
}

function Write-EnvFile {
    param([string]$Path, [string]$Content)
    if (Test-Path $Path) {
        Write-Host "  [=] Ya existe $Path (no se sobrescribe)" -ForegroundColor DarkGray
        return $false
    }
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Set-Content -Path $Path -Value $Content -Encoding UTF8 -NoNewline
    Write-Host "  [+] Creado $Path" -ForegroundColor Green
    return $true
}

Write-Host '=== FINANZA :: preparación del entorno local ===' -ForegroundColor Cyan

# --------------------------------------------------------------------------
# 1. Secretos y archivos .env
# --------------------------------------------------------------------------
Write-Host '1) Variables de entorno'
$dbPassword = New-Secret -Bytes 24
$jwtAccess = New-Secret
$jwtRefresh = New-Secret
$databaseUrl = "postgresql://finanza_app:$dbPassword@localhost:55432/finanza?schema=public"

$rootEnv = @"
# Generado automáticamente por scripts/bootstrap-dev.ps1 — NO versionar.
FINANZA_DB_USER=finanza_app
FINANZA_DB_PASSWORD=$dbPassword
FINANZA_DB_NAME=finanza
FINANZA_DB_PORT=55432

DATABASE_URL=$databaseUrl

FINANZA_API_PORT=3010
FINANZA_WEB_PORT=5180
JWT_ACCESS_SECRET=$jwtAccess
JWT_REFRESH_SECRET=$jwtRefresh

# Web Push (opcional): npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
"@
Write-EnvFile -Path $envFile -Content $rootEnv | Out-Null

# Si el .env ya existía, reutilizamos sus valores para los .env de las apps.
$existingRoot = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $existingRoot[$Matches[1]] = $Matches[2] }
}
if ($existingRoot.ContainsKey('DATABASE_URL')) { $databaseUrl = $existingRoot['DATABASE_URL'] }
if ($existingRoot.ContainsKey('JWT_ACCESS_SECRET')) { $jwtAccess = $existingRoot['JWT_ACCESS_SECRET'] }
if ($existingRoot.ContainsKey('JWT_REFRESH_SECRET')) { $jwtRefresh = $existingRoot['JWT_REFRESH_SECRET'] }

$apiEnv = @"
# Generado automáticamente por scripts/bootstrap-dev.ps1 — NO versionar.
DATABASE_URL=$databaseUrl
NODE_ENV=development
PORT=3010

JWT_ACCESS_SECRET=$jwtAccess
JWT_REFRESH_SECRET=$jwtRefresh
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=2592000

# Ventana de trabajo offline (horas) desde la última autorización válida.
OFFLINE_WINDOW_HOURS=24
BUSINESS_TIMEZONE=America/Santo_Domingo
DEFAULT_CURRENCY=DOP

CORS_ORIGINS=http://localhost:5180,http://localhost:4173

VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com

ATTACHMENTS_DIR=./.datos-locales/adjuntos
MAX_ATTACHMENT_MB=8
"@
Write-EnvFile -Path $apiEnvFile -Content $apiEnv | Out-Null

$webEnv = @"
# Generado automáticamente por scripts/bootstrap-dev.ps1 — NO versionar.
VITE_API_URL=http://localhost:3010/api/v1
VITE_OFFLINE_WINDOW_HOURS=24
"@
Write-EnvFile -Path $webEnvFile -Content $webEnv | Out-Null

# --------------------------------------------------------------------------
# 2. Base de datos aislada
# --------------------------------------------------------------------------
if (-not $SkipDb) {
    Write-Host '2) PostgreSQL aislado (contenedor finanza-postgres, puerto 55432)'
    Push-Location $root
    try {
        docker compose up -d db | Write-Host
        if ($LASTEXITCODE -ne 0) { throw 'docker compose up -d db falló' }

        Write-Host '   Esperando a que la base esté lista...' -NoNewline
        $healthy = $false
        for ($i = 0; $i -lt 40; $i++) {
            $status = (docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null)
            if ($status -eq 'healthy') { $healthy = $true; break }
            Start-Sleep -Milliseconds 1000
            Write-Host '.' -NoNewline
        }
        Write-Host ''
        if (-not $healthy) { throw 'La base de datos no llegó a estado healthy en 40s.' }
        Write-Host '   [OK] Base de datos healthy' -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Host '2) Base de datos: omitida (-SkipDb)'
}

# --------------------------------------------------------------------------
# 3. Dependencias
# --------------------------------------------------------------------------
if (-not $SkipInstall) {
    Write-Host '3) Dependencias npm'
    foreach ($app in @('apps\api', 'apps\web')) {
        $pkg = Join-Path $root (Join-Path $app 'package.json')
        if (-not (Test-Path $pkg)) {
            Write-Host "   [-] $app no existe todavía, se omite" -ForegroundColor DarkGray
            continue
        }
        Write-Host "   Instalando $app ..."
        Push-Location (Join-Path $root $app)
        try {
            npm install --no-fund --no-audit
            if ($LASTEXITCODE -ne 0) { throw "npm install falló en $app" }
        }
        finally {
            Pop-Location
        }
    }
}
else {
    Write-Host '3) Dependencias: omitidas (-SkipInstall)'
}

Write-Host ''
Write-Host 'Listo. Siguientes pasos:' -ForegroundColor Cyan
Write-Host '  cd apps/api; npx prisma migrate dev --name init; npx prisma generate; npx prisma db seed'
Write-Host '  cd apps/api; npm run start:dev'
Write-Host '  cd apps/web; npm run dev'
