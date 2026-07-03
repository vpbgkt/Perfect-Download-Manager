# PDM Browser Integration

Sends downloads and links from Chrome, Edge, and Brave to the running Perfect Download Manager.

## How it works

```
Browser extension (MV3)  --nativeMessaging-->  pdm-native-host.exe  --named pipe-->  PDM app
```

- The extension adds a right-click "Download with PDM" menu and an optional "intercept all
  downloads" toggle.
- The native host relays each URL to the running app over a per-user named pipe
  (`PDM.DownloadRequest`). If PDM is not running, the host launches it and retries.
- Captured downloads land in the same queue, categories, and settings as the UI.

## Install (developer / sideload)

1. Build the app and native host:
   ```powershell
   dotnet build -c Release
   ```
   The host is `src/PDM.NativeHost/bin/Release/net10.0-windows/pdm-native-host.exe`
   (the installer will place it alongside `PDM.exe`).

2. Load the extension:
   - Chrome/Edge/Brave → `chrome://extensions` → enable Developer mode → "Load unpacked" →
     select `browser-extension/chromium`.
   - Copy the extension's **ID** shown on that page.

3. Register the native host with that ID:
   ```powershell
   ./install-native-host.ps1 -HostExe "C:\path\to\pdm-native-host.exe" -ExtensionIds "<your-extension-id>"
   ```

4. Restart the browser. Right-click a link → "Download with PDM".

## Uninstall

```powershell
./install-native-host.ps1 -HostExe "x" -Uninstall
```

## Firefox

Firefox uses the same wire protocol but a different manifest key (`allowed_extensions` with
the add-on ID) and registry path (`HKCU\Software\Mozilla\NativeMessagingHosts`). A Firefox
manifest variant can be generated the same way once the add-on is packaged for AMO.

## Icons

`icons/icon16.png`, `icon48.png`, `icon128.png` are placeholders to be replaced with final art
before store submission.
