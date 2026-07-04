# PDM Documentation

## For end users

- **[USER-GUIDE.md](USER-GUIDE.md)** — installing, downloading, filtering, settings, activation, updates, uninstall.
- **[BROWSER-EXTENSION.md](BROWSER-EXTENSION.md)** — installing and using the Chrome/Edge/Brave extension.

## For operators (running the licensing backend)

- **[API-REFERENCE.md](API-REFERENCE.md)** — every licensing endpoint (`/trial`, `/activate`, `/validate`) with curl/PowerShell examples, request/response shapes, error codes, and the DynamoDB data model.
- **[COMMANDS.md](COMMANDS.md)** — the cheat sheet: build, test, publish, install, deploy the backend, mint / revoke / list licenses, test endpoints, tear down.

## For developers

- **[SECURITY.md](SECURITY.md)** — threat model, anti-forgery model, tamper detection, defense in depth, honest limits.
- **[REMAINING-WORK.md](REMAINING-WORK.md)** — what's still outstanding before public launch (code signing, extension store submissions, payment integration).

## Icon

The app icon (`PDM.ico`) is included in this directory. The installer references it via
`ARPPRODUCTICON` so it shows in *Add or remove programs*.
