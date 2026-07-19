# Generates the WiX installer artwork (banner + dialog background) in PDM's green brand palette,
# replacing the default WiX bitmaps (which read as a red/"CD" theme that feels alarming during an
# install). Run once when the branding changes; the BMPs are committed under installer/.
#
#   ./build/make-installer-art.ps1
#
# Produces:
#   installer/banner.bmp  (493 x 58)   - top banner on interior dialogs
#   installer/dialog.bmp  (493 x 312)  - full background on Welcome/Exit dialogs
#
# Referenced from installer/Package.wxs via WixUIBannerBmp / WixUIDialogBmp.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repo "installer"
$logoPath = Join-Path $repo "src\PDM.App\Assets\pdm-logo.png"

$greenDark  = [System.Drawing.Color]::FromArgb(20, 115, 60)
$greenLight = [System.Drawing.Color]::FromArgb(46, 170, 90)
$white      = [System.Drawing.Color]::White

function New-Bmp([int]$w, [int]$h, [string]$path, [scriptblock]$draw) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    & $draw $g
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
    Write-Host "  wrote $path"
}

$logo = [System.Drawing.Image]::FromFile($logoPath)

# Dialog background: green sidebar (left 164px) with the logo, white content area (rest).
New-Bmp 493 312 (Join-Path $installer "dialog.bmp") {
    param($g)
    $g.Clear($white)
    $rect = New-Object System.Drawing.Rectangle(0, 0, 164, 312)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $greenDark, $greenLight, [single]90)
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()
    $size = 96
    $x = [int]((164 - $size) / 2)
    $g.DrawImage($logo, $x, 96, $size, $size)
}

# Banner: white background (so WiX's black title text stays readable), a green accent underline,
# and the logo on the right.
New-Bmp 493 58 (Join-Path $installer "banner.bmp") {
    param($g)
    $g.Clear($white)
    $accent = New-Object System.Drawing.SolidBrush($greenLight)
    $g.FillRectangle($accent, 0, 55, 493, 3)
    $accent.Dispose()
    $size = 40
    $g.DrawImage($logo, 493 - $size - 14, [int]((58 - $size) / 2), $size, $size)
}

$logo.Dispose()
Write-Host "Installer art written to $installer"
