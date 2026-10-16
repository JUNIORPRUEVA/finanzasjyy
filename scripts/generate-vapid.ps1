#requires -Version 5.1
<#
.SYNOPSIS
    Genera las claves VAPID de FINANZA y las guarda en apps/api/.env.

.DESCRIPTION
    Las notificaciones Web Push necesitan un par de claves VAPID (pública y
    privada). Sin ellas, el servidor no puede enviar nada y la aplicación lo dice
    con esas palabras en Ajustes → Notificaciones.

    Este script:
      1. genera el par de claves localmente con la biblioteca `web-push`,
      2. las escribe en apps/api/.env SIN imprimir la clave privada,
      3. indica qué hacer después (reiniciar la API y activar el dispositivo).

    La clave privada queda sólo en el archivo .env, que está ignorado por Git.
    Nunca se publica ni se muestra por pantalla.

.EXAMPLE
    .\scripts\generate-vapid.ps1
    .\scripts\generate-vapid.ps1 -Force   # reemplaza las claves existentes
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = 'apps/api/.env'

if (-not (Test-Path $envFile)) {
    Write-Host "No existe $envFile. Ejecute primero: .\scripts\bootstrap-dev.ps1" -ForegroundColor Red
    exit 1
}

$content = Get-Content $envFile -Raw
# IMPORTANTE: la comprobación se hace LÍNEA A LÍNEA. Con el texto completo, un
# patrón como `^\s*VAPID_PUBLIC_KEY\s*=\s*\S+` casa también cuando el valor está
# VACÍO: `\s*` se come el salto de línea y `\S+` encaja con la línea siguiente
# («VAPID_PRIVATE_KEY»), así que el script creía que ya había claves.
$hasKeys = @(Get-Content $envFile | Where-Object { $_ -match '^\s*VAPID_PUBLIC_KEY\s*=\s*\S' }).Count -gt 0

if ($hasKeys -and -not $Force) {
    Write-Host 'Ya hay claves VAPID configuradas.' -ForegroundColor Yellow
    Write-Host 'Si las cambia, TODOS los dispositivos suscritos dejarán de recibir avisos y tendrán que volver a activarlos.'
    Write-Host 'Para reemplazarlas: .\scripts\generate-vapid.ps1 -Force'
    exit 0
}

Write-Host ''
Write-Host '==> Generando el par de claves VAPID' -ForegroundColor Cyan

Push-Location 'apps/api'
if (-not (Test-Path 'node_modules/web-push')) {
    Pop-Location
    Write-Host 'Falta la dependencia web-push. Ejecute: npm install --prefix apps/api' -ForegroundColor Red
    exit 1
}

# Se generan en Node y se devuelven en JSON para no imprimir la clave privada.
$json = node -e "const wp=require('web-push');const k=wp.generateVAPIDKeys();process.stdout.write(JSON.stringify(k))"
Pop-Location

if (-not $json) {
    Write-Host 'No se pudieron generar las claves.' -ForegroundColor Red
    exit 1
}

$keys = $json | ConvertFrom-Json

# Se eliminan las claves anteriores (si las había) y se añaden las nuevas.
$lines = Get-Content $envFile | Where-Object { $_ -notmatch '^\s*VAPID_(PUBLIC|PRIVATE)_KEY\s*=' -and $_ -notmatch '^\s*VAPID_SUBJECT\s*=' }
$lines += ''
$lines += '# Notificaciones Web Push (generadas por scripts/generate-vapid.ps1)'
$lines += "VAPID_PUBLIC_KEY=$($keys.publicKey)"
$lines += "VAPID_PRIVATE_KEY=$($keys.privateKey)"
$lines += 'VAPID_SUBJECT=mailto:admin@finanza.local'

Set-Content -Path $envFile -Value $lines -Encoding UTF8

Write-Host '    Claves guardadas en apps/api/.env (la privada NO se muestra)' -ForegroundColor Green
Write-Host "    Clave pública (esta sí es pública): $($keys.publicKey)" -ForegroundColor Gray
Write-Host ''
Write-Host 'Ahora:' -ForegroundColor Cyan
Write-Host '  1. Reinicie la API (Ctrl+C y "npm run start:dev").'
Write-Host '  2. En la PWA: Ajustes -> Notificaciones -> "Activar en este dispositivo".'
Write-Host '  3. Pulse "Enviar notificación de prueba" y compruebe que LLEGA al dispositivo.'
Write-Host ''
Write-Host 'IMPORTANTE: las notificaciones web requieren HTTPS o localhost. En un móvil,'
Write-Host 'instale la aplicación en la pantalla de inicio (en iPhone, iOS 16.4 o superior).'
Write-Host 'Si no llega ninguna notificación, no se puede afirmar que el push funcione.' -ForegroundColor Yellow
Write-Host ''
