#requires -Version 5.1
<#
.SYNOPSIS
    Genera los iconos de la PWA y el favicon a partir del logotipo de FINANZA.

.DESCRIPTION
    Toma UNA imagen de origen y produce todos los tamaños que necesitan Android,
    iPhone, el navegador y la pantalla de inicio:

      pwa-192.png            icono normal (Android y escritorio)
      pwa-512.png            icono normal en alta resolución
      pwa-maskable-512.png   icono «maskable»: Android recorta la forma que quiere
                             (círculo, gota…), así que el dibujo va con margen
      apple-touch-icon.png   icono de iPhone/iPad, sin transparencia (lo exige iOS)
      favicon-32.png         pestaña del navegador
      favicon-48.png         acceso directo de Windows
      favicon.svg            el mismo dibujo en SVG (nítido en cualquier tamaño)
      logo.png               el logotipo recortado, para usarlo dentro de la app

    Además:
      · Recorta automáticamente el margen blanco que suele traer el logotipo.
      · Calcula el color verde dominante y lo muestra, para poder ajustar el color
        del tema (la pantalla de arranque y la barra del navegador).

.USAGE
    1. Guarde el logotipo como PNG (o JPG) en:  apps/web/public/logo-finanza.png
    2. Ejecute:                                 .\scripts\generate-icons.ps1

    Si el logotipo está en otro sitio:  .\scripts\generate-icons.ps1 -Origen "C:\ruta\logo.png"

.NOTES
    Se usa System.Drawing (incluido en Windows) a propósito: no añade ninguna
    dependencia al proyecto ni necesita descargar nada.
#>
[CmdletBinding()]
param(
    [string]$Origen = (Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/web/public/logo-finanza.png'),
    [string]$Salida = (Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/web/public'),
    # Tamaño del dibujo dentro del icono maskable (la zona segura de Android).
    [double]$FactorMaskable = 0.78
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "    $message" -ForegroundColor Green }

if (-not (Test-Path $Origen)) {
    Write-Host ''
    Write-Host '  FALTA EL LOGOTIPO' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Guarde la imagen del logotipo (PNG o JPG) en esta ruta:' -ForegroundColor Yellow
    Write-Host "      $Origen" -ForegroundColor White
    Write-Host ''
    Write-Host '  Cómo hacerlo desde VS Code: abra el Explorador de archivos del proyecto,' -ForegroundColor Gray
    Write-Host '  arrastre la imagen a la carpeta apps/web/public y cámbiele el nombre a' -ForegroundColor Gray
    Write-Host '  logo-finanza.png. Después vuelva a ejecutar este script.' -ForegroundColor Gray
    Write-Host ''
    exit 1
}

if (-not (Test-Path $Salida)) {
    New-Item -ItemType Directory -Path $Salida -Force | Out-Null
}

# ---------------------------------------------------------------------------
# 1. Leer el logotipo y localizar el dibujo (quitando el margen sobrante)
# ---------------------------------------------------------------------------
Write-Step "Leyendo el logotipo: $([System.IO.Path]::GetFileName($Origen))"

$imagen = [System.Drawing.Image]::FromFile($Origen)
$anchoOriginal = $imagen.Width
$altoOriginal = $imagen.Height
Write-Ok "Tamaño original: ${anchoOriginal}x${altoOriginal}"

$lienzo = New-Object System.Drawing.Bitmap($anchoOriginal, $altoOriginal)
$g = [System.Drawing.Graphics]::FromImage($lienzo)
$g.DrawImage($imagen, 0, 0, $anchoOriginal, $altoOriginal)
$g.Dispose()

# Se considera «borde» todo lo casi blanco (los generadores de logotipos suelen
# entregar el dibujo sobre blanco) y todo lo casi transparente.
function Test-Borde([System.Drawing.Color]$color) {
    if ($color.A -lt 24) { return $true }
    return ($color.R -gt 236 -and $color.G -gt 236 -and $color.B -gt 236)
}

$paso = [Math]::Max(1, [int]([Math]::Min($anchoOriginal, $altoOriginal) / 400))
$minX = $anchoOriginal; $minY = $altoOriginal; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $altoOriginal; $y += $paso) {
    for ($x = 0; $x -lt $anchoOriginal; $x += $paso) {
        $color = $lienzo.GetPixel($x, $y)
        if (-not (Test-Borde $color)) {
            if ($x -lt $minX) { $minX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}

if ($maxX -le $minX -or $maxY -le $minY) {
    # Imagen sin bordes claros (ya viene recortada): se usa entera.
    $minX = 0; $minY = 0; $maxX = $anchoOriginal - 1; $maxY = $altoOriginal - 1
    Write-Ok 'El logotipo ya viene recortado: se usa completo'
} else {
    Write-Ok "Dibujo detectado en ($minX,$minY) - ($maxX,$maxY)"
}

$recorte = New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))

# Cuadrado centrado sobre el dibujo: los iconos son cuadrados y no queremos
# deformar el logotipo.
$lado = [Math]::Max($recorte.Width, $recorte.Height)
$centroX = $recorte.X + [int]($recorte.Width / 2)
$centroY = $recorte.Y + [int]($recorte.Height / 2)
$cuadrado = New-Object System.Drawing.Rectangle(
    ($centroX - [int]($lado / 2)),
    ($centroY - [int]($lado / 2)),
    $lado,
    $lado
)

# Si el cuadrado se sale de la imagen, se ajusta dentro.
if ($cuadrado.X -lt 0) { $cuadrado.X = 0 }
if ($cuadrado.Y -lt 0) { $cuadrado.Y = 0 }
if (($cuadrado.X + $cuadrado.Width) -gt $anchoOriginal) { $cuadrado.Width = $anchoOriginal - $cuadrado.X }
if (($cuadrado.Y + $cuadrado.Height) -gt $altoOriginal) { $cuadrado.Height = $altoOriginal - $cuadrado.Y }
$lado = [Math]::Min($cuadrado.Width, $cuadrado.Height)
$cuadrado = New-Object System.Drawing.Rectangle($cuadrado.X, $cuadrado.Y, $lado, $lado)

$arte = $lienzo.Clone($cuadrado, $lienzo.PixelFormat)
$lienzo.Dispose()
$imagen.Dispose()

# ---------------------------------------------------------------------------
# 2. Color dominante (para el tema de la app y la pantalla de arranque)
# ---------------------------------------------------------------------------
$sumaR = 0; $sumaG = 0; $sumaB = 0; $cuenta = 0
$franja = [Math]::Max(1, [int]($arte.Height * 0.08))
for ($y = 0; $y -lt $franja; $y += 2) {
    for ($x = [int]($arte.Width * 0.2); $x -lt [int]($arte.Width * 0.8); $x += 2) {
        $c = $arte.GetPixel($x, $y)
        if ($c.A -gt 200) { $sumaR += $c.R; $sumaG += $c.G; $sumaB += $c.B; $cuenta++ }
    }
}
if ($cuenta -gt 0) {
    $colorDominante = "#{0:X2}{1:X2}{2:X2}" -f [int]($sumaR / $cuenta), [int]($sumaG / $cuenta), [int]($sumaB / $cuenta)
} else {
    $colorDominante = '#0B3B2A'
}
$colorFondo = [System.Drawing.ColorTranslator]::FromHtml($colorDominante)

# ---------------------------------------------------------------------------
# 3. Generar los iconos
# ---------------------------------------------------------------------------
function New-Icono {
    param(
        [System.Drawing.Image]$Dibujo,
        [int]$Tamano,
        [string]$Ruta,
        [Nullable[System.Drawing.Color]]$Fondo = $null,
        [double]$Escala = 1.0
    )

    $destino = New-Object System.Drawing.Bitmap($Tamano, $Tamano)
    $grafico = [System.Drawing.Graphics]::FromImage($destino)
    $grafico.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $grafico.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $grafico.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $grafico.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    if ($null -ne $Fondo) {
        $grafico.Clear($Fondo)
    } else {
        $grafico.Clear([System.Drawing.Color]::Transparent)
    }

    $lado = [int]($Tamano * $Escala)
    $offset = [int](($Tamano - $lado) / 2)
    $grafico.DrawImage($Dibujo, $offset, $offset, $lado, $lado)
    $grafico.Dispose()

    $destino.Save($Ruta, [System.Drawing.Imaging.ImageFormat]::Png)
    $destino.Dispose()
}

Write-Step 'Generando los iconos'

New-Icono -Dibujo $arte -Tamano 192 -Ruta (Join-Path $Salida 'pwa-192.png')
Write-Ok 'pwa-192.png'
New-Icono -Dibujo $arte -Tamano 512 -Ruta (Join-Path $Salida 'pwa-512.png')
Write-Ok 'pwa-512.png'
# Maskable: el dibujo con margen sobre el verde del propio logotipo, porque
# Android recorta la forma que quiera y no puede quedar nada importante fuera.
New-Icono -Dibujo $arte -Tamano 512 -Ruta (Join-Path $Salida 'pwa-maskable-512.png') -Fondo $colorFondo -Escala $FactorMaskable
Write-Ok "pwa-maskable-512.png (dibujo al $([int]($FactorMaskable * 100))%)"
# iPhone: iOS no admite transparencia y redondea él mismo las esquinas.
New-Icono -Dibujo $arte -Tamano 180 -Ruta (Join-Path $Salida 'apple-touch-icon.png') -Fondo $colorFondo
Write-Ok 'apple-touch-icon.png (180px, sin transparencia)'
New-Icono -Dibujo $arte -Tamano 48 -Ruta (Join-Path $Salida 'favicon-48.png')
Write-Ok 'favicon-48.png'
New-Icono -Dibujo $arte -Tamano 32 -Ruta (Join-Path $Salida 'favicon-32.png')
Write-Ok 'favicon-32.png'
New-Icono -Dibujo $arte -Tamano 256 -Ruta (Join-Path $Salida 'logo.png')
Write-Ok 'logo.png (para usar el logotipo dentro de la app)'

# Favicon vectorial: contiene el PNG en pequeño, así se ve nítido en cualquier
# tamaño de pestaña sin depender de ficheros externos.
$temporalPng = Join-Path $Salida '.favicon-64.png'
New-Icono -Dibujo $arte -Tamano 64 -Ruta $temporalPng
$base64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($temporalPng))
Remove-Item $temporalPng -Force
$svg = @"
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <title>FINANZA</title>
  <image href="data:image/png;base64,$base64" width="64" height="64" />
</svg>
"@
[System.IO.File]::WriteAllText((Join-Path $Salida 'favicon.svg'), $svg, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok 'favicon.svg'

$arte.Dispose()

Write-Step 'Resultado'
Write-Host "    Color dominante del logotipo: $colorDominante" -ForegroundColor Yellow
Write-Host ''
Write-Host '    Para que la pantalla de arranque y la barra del navegador usen ese color,'
Write-Host "    póngalo en estos dos sitios: `"theme_color`" y `"background_color`" del manifiesto"
Write-Host '    (apps/web/vite.config.ts) y el <meta name="theme-color"> de apps/web/index.html.'
Write-Host ''
Get-ChildItem $Salida -File | Where-Object { $_.Name -match '^(pwa|apple|favicon|logo)' } |
    Sort-Object Name |
    ForEach-Object { Write-Ok ("{0,-24} {1,8:N0} bytes" -f $_.Name, $_.Length) }
Write-Host ''
Write-Host '  Listo. Recompile la PWA (npm run build --prefix apps/web) o recargue' -ForegroundColor Green
Write-Host '  el servidor de desarrollo para ver los iconos nuevos.' -ForegroundColor Green
Write-Host ''
