# Registers the PDM native messaging host for Chromium browsers (Chrome, Edge, Brave).
#
# Run AFTER loading the extension so you know its ID (chrome://extensions -> Developer mode ->
# the extension's ID). Pass one or more extension IDs.
#
# Usage:
#   ./install-native-host.ps1 -HostExe "C:\Program Files\PDM\pdm-native-host.exe" `
#       -ExtensionIds "abcdefghijklmnopabcdefghijklmnop"
#
# To uninstall: pass -Uninstall.

param(
    [Parameter(Mandatory = $true)][string]$HostExe,
    [string[]]$ExtensionIds = @(),
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$hostName = "com.pdm.host"
$manifestDir = Join-Path $env:LOCALAPPDATA "PerfectDownloadManager\native-host"
$manifestPath = Join-Path $manifestDir "$hostName.json"

# Chromium-family registry locations (per-user).
$browsers = @{
    "Chrome" = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
    "Edge"   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
    "Brave"  = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"
}

if ($Uninstall) {
    foreach ($path in $browsers.Values) {
        if (Test-Path $path) { Remove-Item $path -Force }
    }
    if (Test-Path $manifestPath) { Remove-Item $manifestPath -Force }
    Write-Host "PDM native host unregistered."
    return
}

if (-not (Test-Path $HostExe)) {
    Write-Error "Host executable not found: $HostExe"
    exit 1
}

if ($ExtensionIds.Count -eq 0) {
    Write-Error "Provide at least one -ExtensionIds value (see chrome://extensions)."
    exit 1
}

New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null

$origins = @($ExtensionIds | ForEach-Object { "chrome-extension://$_/" })
$manifest = [ordered]@{
    name            = $hostName
    description     = "Perfect Download Manager native messaging host"
    path            = $HostExe
    type            = "stdio"
    allowed_origins = $origins
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding utf8

foreach ($entry in $browsers.GetEnumerator()) {
    New-Item -Path $entry.Value -Force | Out-Null
    Set-ItemProperty -Path $entry.Value -Name "(default)" -Value $manifestPath
    Write-Host "Registered for $($entry.Key): $($entry.Value)"
}

Write-Host ""
Write-Host "Native host manifest written to: $manifestPath"
Write-Host "Restart the browser for changes to take effect."
