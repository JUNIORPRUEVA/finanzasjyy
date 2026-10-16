#requires -Version 5.1
<#
.SYNOPSIS
    Copia de seguridad de la base de datos de FINANZA (pg_dump dentro del contenedor).

.DESCRIPTION
    Genera un volcado comprimido en formato personalizado (restaurable con
    pg_restore) dentro de la carpeta backups/, con la fecha y la hora en el
    nombre. Se ejecuta DENTRO del contenedor para no depender de que el cliente
    de PostgreSQL esté instalado en Windows.

    No borra ni modifica nada. No toca otros contenedores ni otras bases de datos.

.EXAMPLE
    .\scripts\backup-db.ps1
    .\scripts\backup-db.ps1 -Keep 30
#>
[CmdletBinding()]
param(
    # Número de copias que se conservan. Las más antiguas se archivan, nunca se borran sin avisar.
    [int]$Keep = 14
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Ok($message) { Write-Host "  $message" -ForegroundColor Green }
function Write-Warn2($message) { Write-Host "  $message" -ForegroundColor Yellow }

# Se leen las credenciales del .env, sin imprimirlas nunca.
$envVars = @{}
Get-Content '.env' | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
        $envVars[$matches[1]] = $matches[2].Trim('"').Trim("'")
    }
}

$dbUser = $envVars['FINANZA_DB_USER']
$dbName = if ($envVars.ContainsKey('FINANZA_DB_NAME')) { $envVars['FINANZA_DB_NAME'] } else { 'finanza' }

if (-not $dbUser) {
    Write-Host 'No se pudo leer FINANZA_DB_USER del archivo .env' -ForegroundColor Red
    exit 1
}

$status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
if ($status -ne 'healthy') {
    Write-Host 'El contenedor finanza-postgres no está disponible. Levántelo con: docker compose up -d db' -ForegroundColor Red
    exit 1
}

$backupDir = Join-Path $root 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$fileName = "finanza_$stamp.dump"
$containerPath = "/tmp/$fileName"

Write-Host "`n==> Copia de seguridad de la base de datos «$dbName»" -ForegroundColor Cyan

docker exec finanza-postgres pg_dump --username $dbUser --dbname $dbName --format custom --compress 6 --file $containerPath
if ($LASTEXITCODE -ne 0) {
    Write-Host 'El volcado falló.' -ForegroundColor Red
    exit 1
}

docker cp "finanza-postgres:$containerPath" (Join-Path $backupDir $fileName)
if ($LASTEXITCODE -ne 0) {
    Write-Host 'No se pudo copiar el volcado al equipo.' -ForegroundColor Red
    exit 1
}

docker exec finanza-postgres rm -f $containerPath | Out-Null

$size = [math]::Round((Get-Item (Join-Path $backupDir $fileName)).Length / 1KB, 1)
Write-Ok "Creado: backups\$fileName ($size KB)"

# Rotación conservadora: informa de las copias antiguas en lugar de borrarlas en silencio.
$all = Get-ChildItem $backupDir -Filter 'finanza_*.dump' | Sort-Object LastWriteTime -Descending
if ($all.Count -gt $Keep) {
    Write-Warn2 "$($all.Count) copias en total; las más antiguas que $Keep son:"
    $all[$Keep..($all.Count - 1)] | ForEach-Object { Write-Warn2 "    $($_.Name)  ($($_.LastWriteTime))" }
    Write-Warn2 'No se ha borrado nada. Elimínelas usted si lo considera oportuno.'
}

Write-Host ''
