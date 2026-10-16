#requires -Version 5.1
<#
.SYNOPSIS
  Regenera apps/api/.env y apps/web/.env a partir del .env raíz.

.DESCRIPTION
  El .env raíz es la única fuente de verdad de los secretos locales (lo genera
  scripts/bootstrap-dev.ps1). Este script propaga esos valores a cada aplicación
  sin imprimirlos nunca en pantalla.

  Úsalo cuando un .env de aplicación se haya corrompido o sobreescrito,
  o cuando cambies la contraseña de la base de datos.

.EXAMPLE
  pwsh -File scripts/sync-env.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$rootEnvPath = Join-Path $root '.env'

if (-not (Test-Path $rootEnvPath)) {
    throw "No existe $rootEnvPath. Ejecuta primero: pwsh -File scripts/bootstrap-dev.ps1"
}

$values = @{}
Get-Content $rootEnvPath | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
}

foreach ($required in @('DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET')) {
    if (-not $values.ContainsKey($required) -or [string]::IsNullOrWhiteSpace($values[$required])) {
        throw "El .env raíz no define $required. Vuelve a ejecutar scripts/bootstrap-dev.ps1."
    }
}

# LAS CLAVES DE NOTIFICACIONES NO SE BORRAN
# ----------------------------------------
# `generate-vapid.ps1` escribe las claves en apps/api/.env, no en el .env raíz. Si
# se ejecuta este script después (o se vuelve a ejecutar bootstrap), el valor del
# .env raíz sigue vacío y se SOBRESCRIBIRÍA la clave que ya funcionaba: las
# notificaciones dejarían de enviarse sin ningún aviso.
# Por eso: si el .env raíz no las tiene pero el de la API ya las tenía, se
# conservan las que había.
$apiEnvPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/api/.env'
$apiEnvPrevio = @{}
if (Test-Path $apiEnvPath) {
    foreach ($linea in (Get-Content $apiEnvPath)) {
        if ($linea -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $apiEnvPrevio[$Matches[1]] = $Matches[2].Trim() }
    }
}

foreach ($clave in @('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT')) {
    if ([string]::IsNullOrWhiteSpace($values[$clave]) -and -not [string]::IsNullOrWhiteSpace($apiEnvPrevio[$clave])) {
        $values[$clave] = $apiEnvPrevio[$clave]
        Write-Host "    Se conservan las claves de notificaciones que ya estaban en apps/api/.env ($clave)" -ForegroundColor Yellow
    }
}

$apiEnv = @"
# Generado por scripts/sync-env.ps1 a partir del .env raíz — NO versionar.
DATABASE_URL=$($values['DATABASE_URL'])
NODE_ENV=development
PORT=3010

JWT_ACCESS_SECRET=$($values['JWT_ACCESS_SECRET'])
JWT_REFRESH_SECRET=$($values['JWT_REFRESH_SECRET'])
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=2592000

OFFLINE_WINDOW_HOURS=24
BUSINESS_TIMEZONE=America/Santo_Domingo
DEFAULT_CURRENCY=DOP

CORS_ORIGINS=http://localhost:5180,http://localhost:4173

VAPID_PUBLIC_KEY=$($values['VAPID_PUBLIC_KEY'])
VAPID_PRIVATE_KEY=$($values['VAPID_PRIVATE_KEY'])
VAPID_SUBJECT=$($values['VAPID_SUBJECT'])

ATTACHMENTS_DIR=./.datos-locales/adjuntos
MAX_ATTACHMENT_MB=8
"@

$webEnv = @"
# Generado por scripts/sync-env.ps1 a partir del .env raíz — NO versionar.
#
# La PWA habla con la API por la MISMA dirección desde la que se sirve, usando la
# ruta relativa. En desarrollo la reenvía el servidor de Vite (vite.config.ts) y
# en producción nginx (apps/web/nginx.conf). Así no hay peticiones entre orígenes
# distintos: las cookies de sesión viajan sin problemas y no hacen falta reglas
# de CORS.
#
# NO ponga aquí la dirección absoluta de la API (http://localhost:3010/...)
# salvo que sirva la PWA y la API en dominios distintos: obligaría al navegador a
# hacer «preflight» de CORS en cada petición, y si la API no autoriza alguna
# cabecera propia (X-Session-Mode, X-CSRF-Token) BLOQUEARÍA el acceso con un
# error que en la pantalla se ve como «no se pudo contactar con el servidor».
VITE_API_URL=/api/v1
VITE_OFFLINE_WINDOW_HOURS=24
"@

Set-Content -Path (Join-Path $root 'apps\api\.env') -Value $apiEnv -Encoding UTF8 -NoNewline
Write-Host '  [+] apps\api\.env regenerado' -ForegroundColor Green

$webDir = Join-Path $root 'apps\web'
if (Test-Path $webDir) {
    Set-Content -Path (Join-Path $webDir '.env') -Value $webEnv -Encoding UTF8 -NoNewline
    Write-Host '  [+] apps\web\.env regenerado' -ForegroundColor Green
}

Write-Host 'Entorno sincronizado.' -ForegroundColor Cyan
