#requires -Version 5.1
<#
.SYNOPSIS
    PRUEBA DE RESTAURACIÓN de FINANZA: restaura una copia en una base de datos
    APARTE (finanza_restore_test) para comprobar que la copia sirve de verdad.

.DESCRIPTION
    Una copia de seguridad que nunca se ha restaurado no es una copia de
    seguridad. Este script:
      1. crea (si no existe) la base de datos finanza_restore_test,
      2. restaura en ella el volcado indicado,
      3. comprueba que las tablas y los asientos contables cuadran,
      4. elimina esa base de datos de prueba al terminar (con -Keep para revisarla).

    NUNCA restaura sobre la base de datos de trabajo y nunca borra datos reales.
    Si el volcado indicado no existe, usa el más reciente de backups/.

.EXAMPLE
    .\scripts\restore-test.ps1
    .\scripts\restore-test.ps1 -Dump backups\finanza_2026-10-16_09-00-00.dump -Keep
#>
[CmdletBinding()]
param(
    [string]$Dump,
    # Si se indica, la base de datos de prueba NO se elimina al terminar.
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$TEST_DB = 'finanza_restore_test'

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "    OK   $message" -ForegroundColor Green }
function Write-Bad($message) { Write-Host "    FALLA $message" -ForegroundColor Red }

$envVars = @{}
Get-Content '.env' | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
        $envVars[$matches[1]] = $matches[2].Trim('"').Trim("'")
    }
}
$dbUser = $envVars['FINANZA_DB_USER']
if (-not $dbUser) {
    Write-Host 'No se pudo leer FINANZA_DB_USER del archivo .env' -ForegroundColor Red
    exit 1
}

$status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
if ($status -ne 'healthy') {
    Write-Host 'El contenedor finanza-postgres no está disponible. Levántelo con: docker compose up -d db' -ForegroundColor Red
    exit 1
}

if (-not $Dump) {
    $latest = Get-ChildItem (Join-Path $root 'backups') -Filter 'finanza_*.dump' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) {
        Write-Host 'No hay copias en backups/. Ejecute antes: .\scripts\backup-db.ps1' -ForegroundColor Red
        exit 1
    }
    $Dump = $latest.FullName
}
if (-not (Test-Path $Dump)) {
    Write-Host "No existe el archivo indicado: $Dump" -ForegroundColor Red
    exit 1
}

Write-Step "Restaurando «$(Split-Path -Leaf $Dump)» en la base de datos de prueba $TEST_DB"

# 1. Base de datos de prueba limpia (sólo esa base, nunca la de trabajo).
docker exec finanza-postgres psql --username $dbUser --dbname postgres --command "DROP DATABASE IF EXISTS $TEST_DB" | Out-Null
docker exec finanza-postgres psql --username $dbUser --dbname postgres --command "CREATE DATABASE $TEST_DB" | Out-Null
Write-Ok 'Base de datos de prueba creada'

# 2. El volcado se copia al contenedor y se restaura ahí.
$containerPath = "/tmp/$([System.IO.Path]::GetFileName($Dump))"
docker cp $Dump "finanza-postgres:$containerPath" | Out-Null

docker exec finanza-postgres pg_restore --username $dbUser --dbname $TEST_DB --no-owner --no-privileges $containerPath
if ($LASTEXITCODE -ne 0) {
    Write-Bad 'La restauración devolvió errores (revise la salida anterior)'
    $failed = $true
}
else {
    Write-Ok 'Restauración terminada sin errores'
    $failed = $false
}

# 3. Comprobaciones reales sobre la copia restaurada.
Write-Step 'Comprobando la copia restaurada'

# El SQL se envía por la entrada estándar: PowerShell 5.1 se come las comillas
# dobles de los argumentos y psql buscaría las tablas en minúsculas.
function Invoke-Sql([string]$database, [string]$sql) {
    $sql | docker exec -i finanza-postgres psql --username $dbUser --dbname $database --tuples-only --no-align
}

$tables = Invoke-Sql $TEST_DB "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
Write-Ok "Tablas en la copia: $($tables.Trim())"

$unbalanced = Invoke-Sql $TEST_DB @'
SELECT count(*) FROM (
  SELECT e.id
  FROM "JournalEntry" e
  JOIN "JournalLine" l ON l."entryId" = e.id
  GROUP BY e.id
  HAVING SUM(l.debit) <> SUM(l.credit)
) AS descuadrados;
'@
if ($unbalanced.Trim() -eq '0') {
    Write-Ok 'Todos los asientos de la copia están cuadrados (debe = haber)'
}
else {
    Write-Bad "Hay $($unbalanced.Trim()) asientos descuadrados en la copia"
    $failed = $true
}

$entries = Invoke-Sql $TEST_DB 'SELECT count(*) FROM "JournalEntry";'
$transactions = Invoke-Sql $TEST_DB 'SELECT count(*) FROM "FinancialTransaction";'
Write-Ok "Asientos: $($entries.Trim()) · Movimientos: $($transactions.Trim())"

# 4. Limpieza de la base de prueba.
if ($Keep) {
    Write-Host ''
    Write-Host "La base de datos de prueba $TEST_DB se ha conservado para que la revise." -ForegroundColor Yellow
    Write-Host "Para eliminarla: docker exec finanza-postgres psql -U $dbUser -d postgres -c `"DROP DATABASE $TEST_DB`""
}
else {
    docker exec finanza-postgres psql --username $dbUser --dbname postgres --command "DROP DATABASE IF EXISTS $TEST_DB" | Out-Null
    Write-Ok 'Base de datos de prueba eliminada (la de trabajo no se ha tocado)'
}

Write-Host ''
if ($failed) {
    Write-Host 'RESULTADO: la copia NO se pudo verificar por completo.' -ForegroundColor Red
    exit 1
}
Write-Host 'RESULTADO: la copia se restaura y sus datos contables son coherentes.' -ForegroundColor Green
