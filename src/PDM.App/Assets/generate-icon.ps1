# Generates a minimal placeholder icon so the app builds without external assets.
# Real production art should replace pdm.ico before shipping.
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(32, 32)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 30, 110, 200))
$font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::White
$g.DrawString('P', $font, $brush, 6, 4)
$g.Dispose()

$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$path = Join-Path $PSScriptRoot 'pdm.ico'
$stream = [System.IO.File]::Create($path)
$icon.Save($stream)
$stream.Close()
$icon.Dispose()
$bmp.Dispose()
Write-Host "Wrote $path"
