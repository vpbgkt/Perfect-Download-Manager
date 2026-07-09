# Generates the PDM browser-extension icons (16 / 32 / 48 / 128 px) as PNGs from the official
# app logo (src/PDM.App/Assets/pdm.ico). This keeps the extension's identity identical to the
# desktop app in the browser toolbar and the Chrome Web Store listing.
#
# Usage:  ./build/make-icons.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repo    = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $repo "browser-extension\chromium\icons"
$icoPath = Join-Path $repo "src\PDM.App\Assets\pdm.ico"

if (-not (Test-Path $icoPath)) { throw "Official app icon not found: $icoPath" }
New-Item -ItemType Directory -Path $iconDir -Force | Out-Null

# Load the highest-resolution frame available in the .ico so downscales stay crisp.
$bytes = [System.IO.File]::ReadAllBytes($icoPath)
$best = $null
foreach ($size in @(256, 128, 96, 64, 48, 32, 16)) {
    try {
        $ms  = New-Object System.IO.MemoryStream(,$bytes)
        $ico = New-Object System.Drawing.Icon($ms, (New-Object System.Drawing.Size($size, $size)))
        $bmp = $ico.ToBitmap()
        if ($bmp.Width -ge $size - 1) { $best = $bmp; break }
        $bmp.Dispose(); $ico.Dispose(); $ms.Dispose()
    } catch { }
}
if ($null -eq $best) {
    $best = New-Object System.Drawing.Bitmap([System.Drawing.Image]::FromFile($icoPath))
}
Write-Host ("Source frame: {0}x{1}" -f $best.Width, $best.Height)

function Save-Png([System.Drawing.Bitmap]$src, [int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("  {0}  ({1}x{1})" -f (Split-Path $path -Leaf), $size)
}

Write-Host "Generating PDM extension icons from the official app logo:"
Save-Png $best 16  (Join-Path $iconDir "icon16.png")
Save-Png $best 32  (Join-Path $iconDir "icon32.png")
Save-Png $best 48  (Join-Path $iconDir "icon48.png")
Save-Png $best 128 (Join-Path $iconDir "icon128.png")
$best.Dispose()
Write-Host "Done."
