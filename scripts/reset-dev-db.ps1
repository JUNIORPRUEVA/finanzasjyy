#requires -Version 5.1
<#
.SYNOPSIS
    DEJA LIMPIA la base de datos de trabajo de FINANZA: borra los datos, conserva
    la estructura y elimina los restos de las pruebas.

.DESCRIPTION
    ATENCIÓN: BORRA TODOS LOS DATOS de la base de datos «finanza». No se puede
    deshacer. Existe porque, hasta que se aislaron las pruebas, la base de trabajo
    podía contener datos creados por las pruebas automatizadas (unidades y
    movimientos con nombres de prueba).

    Qué hace exactamente:
      1. Exige escribir la palabra LIMPIAR como confirmación (y rechaza ejecutarse en producción).
      2. Guarda antes una copia de seguridad completa en backups\ (a menos que use -SinCopia).
      3. Elimina SÓLO la base de datos «finanza» del contenedor finanza-postgres.
      4. La vuelve a crear vacía, aplica las migraciones y ejecuta la semilla estructural.
      5. Informa de lo que queda: catálogo contable, categorías, unidades y usuario, y CERO movimientos.

    No toca finanza_test, ni backups, ni ningún otro contenedor.

.EXAMPLE
    .\scripts\reset-dev-db.ps1
#>
[CmdletBinding()]
param(
    # Omite la copia de seguridad previa (no recomendado).
    [switch]$SinCopia
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$WORK_DB = 'finanza'

if ($env:NODE_ENV -eq 'production') {
    Write-Host 'Este script no se ejecuta en producción, bajo ninguna circunstancia.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '==========================================================================' -ForegroundColor Yellow
Write-Host '  VAS A BORRAR TODOS LOS DATOS DE LA BASE DE DATOS «finanza»' -ForegroundColor Yellow
Write-Host '' -ForegroundColor Yellow
Write-Host '  Se eliminan movimientos, cuentas, cierres, préstamos, presupuestos,' -ForegroundColor Yellow
Write-Host '  unidades financieras y usuarios. Después se aplica la semilla y quedará' -ForegroundColor Yellow
Write-Host '  el sistema vacío, listo para introducir tus cifras reales.' -ForegroundColor Yellow
Write-Host '  Esto NO se puede deshacer.' -ForegroundColor Yellow
Write-Host '==========================================================================' -ForegroundColor Yellow
Write-Host ''
$answer = Read-Host 'Escriba LIMPIAR (en mayúsculas) para continuar'

if ($answer -ne 'LIMPIAR') {
    Write-Host 'Operación cancelada. No se ha borrado nada.' -ForegroundColor Green
    exit 0
}

$status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
if ($status -ne 'healthy') {
    Write-Host 'El contenedor finanza-postgres no está disponible. Levántelo con: docker compose up -d db' -ForegroundColor Red
    exit 1
}

$dbUser = 'finanza_app'
Get-Content '.env' | ForEach-Object {
    if ($_ -match '^\s*FINANZA_DB_USER\s*=\s*(.*)$') { $script:dbUser = $matches[1].Trim('"').Trim("'") }
}
$dbUser = $script:dbUser

# ----------------------------- Copia previa -------------------------------
if (-not $SinCopia) {
    Write-Host ''
    Write-Host '==> Copia de seguridad previa (por si acaso)' -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot 'backup-db.ps1')
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'La copia de seguridad falló: no se borra nada.' -ForegroundColor Red
        exit 1
    }
}

# --------------------- Aviso sobre conexiones abiertas --------------------
Write-Host ''
Write-Host '==> Cerrando conexiones abiertas a la base de datos' -ForegroundColor Cyan
docker exec finanza-postgres psql --username $dbUser --dbname postgres --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$WORK_DB' AND pid <> pg_backend_pid()" | Out-Null
Write-Host '    (si la API estaba arrancada, se desconectará: vuelva a arrancarla al terminar)' -ForegroundColor Yellow

# ------------------------------ Recreación --------------------------------
Write-Host ''
Write-Host '==> Recreando la base de datos' -ForegroundColor Cyan
docker exec finanza-postgres psql --username $dbUser --dbname postgres --command "DROP DATABASE IF EXISTS $WORK_DB" | Out-Null
docker exec finanza-postgres psql --username $dbUser --dbname postgres --command "CREATE DATABASE $WORK_DB" | Out-Null
Write-Host '    Base de datos vacía creada' -ForegroundColor Green

Write-Host ''
Write-Host '==> Aplicando migraciones' -ForegroundColor Cyan
Push-Location 'apps/api'

# PowerShell 5.1 convierte en error terminante cualquier salida de stderr de una
# herramienta nativa cuando ErrorActionPreference es 'Stop' (Prisma escribe ahí
# sus avisos). Se baja a 'Continue' y se decide con $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
npx prisma migrate deploy 2>&1 | Select-Object -Last 3 | Out-Host
if ($LASTEXITCODE -ne 0) {
    $ErrorActionPreference = 'Stop'
    Write-Host 'Fallaron las migraciones.' -ForegroundColor Red
    Pop-Location
    exit 1
}
npx prisma generate 2>&1 | Select-Object -Last 2 | Out-Host

Write-Host ''
Write-Host '==> Semilla estructural (sin importes)' -ForegroundColor Cyan
npm run db:seed
$seedExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($seedExit -ne 0) {
    Write-Host 'Falló la semilla.' -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# ------------------------------ Comprobación ------------------------------
Write-Host ''
Write-Host '==> Estado final de la base de datos' -ForegroundColor Cyan

# El SQL viaja por la entrada estándar: PowerShell 5.1 se come las comillas
# dobles de los argumentos y psql buscaría las tablas en minúsculas.
function Invoke-Sql([string]$database, [string]$sql) {
    $sql | docker exec -i finanza-postgres psql --username $dbUser --dbname $database --tuples-only --no-align
}

$movements = Invoke-Sql $WORK_DB 'SELECT count(*) FROM "FinancialTransaction";'
$entities = Invoke-Sql $WORK_DB 'SELECT count(*) FROM "FinancialEntity";'
$ledger = Invoke-Sql $WORK_DB 'SELECT count(*) FROM "LedgerAccount";'
$categories = Invoke-Sql $WORK_DB 'SELECT count(*) FROM "TransactionCategory";'
$closings = Invoke-Sql $WORK_DB 'SELECT count(*) FROM "DailyClosing";'
$testDb = Invoke-Sql 'postgres' "SELECT count(*) FROM pg_database WHERE datname = 'finanza_test';"

Write-Host "    Movimientos financieros : $($movements.Trim())   (debe ser 0)"
Write-Host "    Cierres                 : $($closings.Trim())   (debe ser 0)"
Write-Host "    Unidades financieras    : $($entities.Trim())   (las 4 iniciales)"
Write-Host "    Cuentas del catálogo    : $($ledger.Trim())"
Write-Host "    Categorías              : $($categories.Trim())"
Write-Host "    Base de datos de pruebas: $($testDb.Trim())   (1 = existe y está aparte)"

Write-Host ''
Write-Host 'Listo. La aplicación arranca sin ningún importe inventado.' -ForegroundColor Green
if ($movements.Trim() -ne '0' -or $closings.Trim() -ne '0') {
    Write-Host 'AVISO: quedan movimientos o cierres; revísalo.' -ForegroundColor Yellow
    exit 1
}
