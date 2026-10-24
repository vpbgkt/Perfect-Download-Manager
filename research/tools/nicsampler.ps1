# Samples total bytes received across all up, non-loopback NICs every 250 ms until $StopFile exists.
# Output lines: "<seconds since start> <cumulative bytes received since start>"
param([string]$OutFile, [string]$StopFile)
$nics = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' }
function Total { $s = 0; foreach ($n in $nics) { $s += $n.GetIPStatistics().BytesReceived }; $s }
$base = Total
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$lines = New-Object System.Collections.Generic.List[string]
while (-not (Test-Path $StopFile)) {
    $lines.Add(('{0:F3} {1}' -f $sw.Elapsed.TotalSeconds, ((Total) - $base)))
    Start-Sleep -Milliseconds 250
}
$lines.Add(('{0:F3} {1}' -f $sw.Elapsed.TotalSeconds, ((Total) - $base)))
[System.IO.File]::WriteAllLines($OutFile, $lines)
