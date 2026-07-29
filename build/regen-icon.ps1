# Regenerates src/PDM.App.Avalonia/Assets/pdm.ico from the 128px logo with crisp 32-bpp frames at
# every common size (16..256). The previous icon's 16x16 frame was only 8-bpp, so the Windows title
# bar (which uses the 16px frame) rendered a muddy, low-contrast icon. Each frame here is a
# high-quality bicubic downscale stored as PNG (a valid, Windows-supported ICO frame encoding).
param(
    [string]$Source = "$PSScriptRoot/../src/PDM.App.Avalonia/Assets/pdm-logo.png",
    [string]$Output = "$PSScriptRoot/../src/PDM.App.Avalonia/Assets/pdm.ico"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sizes = 16, 20, 24, 32, 48, 64, 128, 256
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))

try {
    $frames = @()
    foreach ($size in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.Clear([System.Drawing.Color]::Transparent)
            $g.DrawImage($src, 0, 0, $size, $size)
        } finally {
            $g.Dispose()
        }

        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $frames += , $ms.ToArray()
        $ms.Dispose()
    }

    # Assemble the ICO container: 6-byte header + 16-byte directory entry per frame + PNG payloads.
    $out = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($out)
    $bw.Write([UInt16]0)            # reserved
    $bw.Write([UInt16]1)            # type: icon
    $bw.Write([UInt16]$sizes.Count) # frame count

    $offset = 6 + (16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = $sizes[$i]
        $data = $frames[$i]
        $dim = if ($size -ge 256) { 0 } else { $size }
        $bw.Write([byte]$dim)       # width  (0 => 256)
        $bw.Write([byte]$dim)       # height (0 => 256)
        $bw.Write([byte]0)          # palette count
        $bw.Write([byte]0)          # reserved
        $bw.Write([UInt16]1)        # colour planes
        $bw.Write([UInt16]32)       # bits per pixel
        $bw.Write([UInt32]$data.Length)
        $bw.Write([UInt32]$offset)
        $offset += $data.Length
    }

    foreach ($data in $frames) { $bw.Write($data) }

    $bw.Flush()
    [System.IO.File]::WriteAllBytes((Resolve-Path $Output).Path, $out.ToArray())
    $bw.Dispose()
    $out.Dispose()
} finally {
    $src.Dispose()
}

Write-Host "Regenerated $Output with 32-bpp frames: $($sizes -join ', ')" -ForegroundColor Green
