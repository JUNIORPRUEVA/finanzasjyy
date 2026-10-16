#requires -Version 5.1
<#
.SYNOPSIS
    Crea (o recrea) la base de datos de PRUEBAS de FINANZA: finanza_test.

.DESCRIPTION
    Las pruebas de extremo a extremo crean movimientos, cierres, préstamos y
    unidades financieras de verdad. Esta base de datos existe para que nunca
    toquen las cuentas reales:

      · base de datos de trabajo : finanza
      · base de datos de pruebas : finanza_test

    El script aplica las migraciones a finanza_test y comprueba que la de trabajo
    NO se ha tocado. Si ya existía, la elimina y la vuelve a crear (sólo esa).

.EXAMPLE
    .\scripts\create-test-db.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$TEST_DB = 'finanza_test'
$WORK_DB = 'finanza'

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "    $message" -ForegroundColor Green }

$status = docker inspect --format '{{.State.Health.Status}}' finanza-postgres 2>$null
if ($status -ne 'healthy') {
    Write-Host 'El contenedor finanza-postgres no está disponible. Levántelo con: docker compose up -d db' -ForegroundColor Red
    exit 1
}

$dbUser = 'finanza_app'
if (Test-Path '.env') {
    Get-Content '.env' | ForEach-Object {
        if ($_ -match '^\s*FINANZA_DB_USER\s*=\s*(.*)$') { $script:dbUser = $matches[1].Trim('"').Trim("'") }
    }
    $dbUser = $script:dbUser
}

Write-Step "Preparando la base de datos de pruebas «$TEST_DB»"

# Sólo se elimina la base de datos de PRUEBAS. Nunca la de trabajo.
docker exec finanza-postgres psql --username $dbUser --dbname postgres --command "DROP DATABASE IF EXISTS $TEST_DB" | Out-Null
docker exec finanza-postgres psql --username $dbUser --dbname postgres --command "CREATE DATABASE $TEST_DB" | Out-Null
Write-Ok "Base de datos $TEST_DB creada"

# Se leen credenciales del .env para construir la URL de pruebas (sin imprimirla).
$dbPassword = $null
Get-Content 'apps/api/.env' | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL\s*=\s*(.*)$') { $script:url = $matches[1].Trim('"').Trim("'") }
}
$url = $script:url
if (-not $url) {
    Write-Host 'No se pudo leer DATABASE_URL de apps/api/.env' -ForegroundColor Red
    exit 1
}
$testUrl = $url -replace '/finanza(\?|$)', "/$TEST_DB`$1"
if ($testUrl -eq $url) {
    Write-Host "No se pudo derivar la URL de pruebas a partir de DATABASE_URL (¿la base no se llama $WORK_DB?)" -ForegroundColor Red
    exit 1
}

Write-Step "Aplicando migraciones a $TEST_DB"
Push-Location 'apps/api'
$env:DATABASE_URL = $testUrl

# NOTA (gotcha de PowerShell 5.1): si ErrorActionPreference está en 'Stop',
# cualquier línea que una herramienta nativa escriba en stderr (Prisma escribe
# "Loaded Prisma config..." o los avisos de migración ahí) se convierte en un
# error terminante y aborta el script aunque el comando haya ido bien. Por eso
# aquí se baja a 'Continue' y el resultado se decide con $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
npx prisma migrate deploy 2>&1 | Select-Object -Last 4 | Out-Host
$exit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'

Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
Pop-Location

if ($exit -ne 0) {
    Write-Host "Falló la aplicación de migraciones a $TEST_DB" -ForegroundColor Red
    exit 1
}

# Las pruebas de extremo a extremo necesitan la estructura mínima (catálogo
# contable, categorías, unidades y usuario) igual que una instalación real: sin
# ella no se puede registrar nada, y eso es precisamente lo que comprueban.
#
# El usuario propietario de la base de PRUEBAS se crea con una contraseña fija y
# conocida, para que las pruebas de navegador puedan entrar sin depender de un
# valor aleatorio que habría que leer del registro. Es seguro porque esta base de
# datos es desechable y se vuelve a crear en cada verificación; la base de
# trabajo (finanza) sigue generando su contraseña aleatoria, que sólo se muestra
# una vez.
Write-Step "Aplicando la semilla estructural a $TEST_DB"
Push-Location 'apps/api'
$env:DATABASE_URL = $testUrl
$env:ADMIN_PASSWORD = 'FinanzaE2E2026!segura'
$env:ADMIN_EMAIL = 'e2e@finanza.test'
$env:ADMIN_NAME = 'Pruebas Automáticas'
$ErrorActionPreference = 'Continue'
npm run db:seed 2>&1 | Select-Object -Last 6 | Out-Host
$seedExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\ADMIN_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:\ADMIN_EMAIL -ErrorAction SilentlyContinue
Remove-Item Env:\ADMIN_NAME -ErrorAction SilentlyContinue
Pop-Location

if ($seedExit -ne 0) {
    Write-Host "Falló la semilla sobre $TEST_DB" -ForegroundColor Red
    exit 1
}
Write-Ok 'Estructura creada en la base de datos de pruebas (sin importes)'
Write-Ok 'Usuario de pruebas: e2e@finanza.test / FinanzaE2E2026!segura'

Write-Step 'Comprobación final'

# El SQL se envía por la entrada estándar, NO como argumento: PowerShell 5.1 se
# come las comillas dobles de los argumentos y PostgreSQL acabaría buscando
# «financialtransaction» (todo en minúsculas) en lugar de «FinancialTransaction».
function Invoke-Sql([string]$database, [string]$sql) {
    $sql | docker exec -i finanza-postgres psql --username $dbUser --dbname $database --tuples-only --no-align
}

$testTables = Invoke-Sql $TEST_DB "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
$workMovements = Invoke-Sql $WORK_DB 'SELECT count(*) FROM "FinancialTransaction";'
Write-Ok "Tablas en $TEST_DB : $($testTables.Trim())"
Write-Ok "Movimientos en $WORK_DB (base de trabajo, intacta): $($workMovements.Trim())"
Write-Host ''
Write-Host "Listo. Las pruebas de extremo a extremo usarán $TEST_DB automaticamente" -ForegroundColor Green
