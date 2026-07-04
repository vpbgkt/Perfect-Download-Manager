# Commands Cheat Sheet

Every command you'll routinely run, grouped by task. Assumes you're at the repo root.

## Build and test

```powershell
# Full solution build (Debug)
dotnet build

# Release build (strips symbols, enables optimization)
dotnet build -c Release

# Run every unit + integration test
dotnet test
```

## Run the app in Debug (no installer)

```powershell
dotnet run --project src/PDM.App
```

## Run the CLI download engine (portable one-off downloads)

```powershell
dotnet run --project src/PDM.Cli -- "https://example.com/file.bin" ".\downloads" --connections 8
# Ctrl+C to pause; re-run the same command to resume from persisted state.
```

## Packaging a release

```powershell
# 1. Publish app + native host + update launcher into dist/PDM and a portable/update zip
./build/publish.ps1 -Version 1.0.0

# 2. Build the MSI installer (dist/PDM-1.0.0.0.msi)
./build/build-installer.ps1 -Version 1.0.0.0

# 3. (optional) Harden the licensing assembly with obfuscation
./build/obfuscate.ps1
```

The MSI is unsigned. For public distribution, sign PDM.exe, the helper exes, and the .msi with a
code-signing certificate (see docs/REMAINING-WORK.md).

## Install the built MSI

```powershell
# Interactive (multi-step UI: welcome / license / install-dir / features / progress / finish)
msiexec /i dist/PDM-1.0.0.0.msi

# Silent (per-user, no admin needed)
msiexec /i dist/PDM-1.0.0.0.msi /qn

# Silent uninstall
msiexec /x dist/PDM-1.0.0.0.msi /qn
```

## Licensing backend — deploy & operate

**Deploy or update the stack** (region ap-south-1, generates keys on first run):
```powershell
./backend/licensing/deploy.ps1

# Rotate the signing key (invalidates all existing tokens)
./backend/licensing/deploy.ps1 -RotateKeys
```

**Mint a license** (perpetual, 1 machine):
```powershell
node backend/licensing/admin/create-license.mjs `
  --region ap-south-1 --table pdm-licenses `
  --owner "Customer Name" --max-activations 1 --features pro
```

**Mint a 1-year subscription license** (single machine):
```powershell
node backend/licensing/admin/create-license.mjs `
  --region ap-south-1 --table pdm-licenses `
  --owner "Customer Name" --max-activations 1 --expires 2027-07-01
```

**List all licenses**:
```powershell
aws dynamodb scan --table-name pdm-licenses --region ap-south-1 --output table
```

**Look up one license**:
```powershell
aws dynamodb get-item --table-name pdm-licenses --region ap-south-1 `
  --key '{"licenseKey":{"S":"PDM-XXXX-XXXX-XXXX-XXXX"}}'
```

**Revoke a license**:
```powershell
aws dynamodb update-item --table-name pdm-licenses --region ap-south-1 `
  --key '{"licenseKey":{"S":"PDM-XXXX-XXXX-XXXX-XXXX"}}' `
  --update-expression "SET #s = :r" `
  --expression-attribute-names '{"#s":"status"}' `
  --expression-attribute-values '{":r":{"S":"revoked"}}'
```

**Reactivate a license**:
```powershell
aws dynamodb update-item --table-name pdm-licenses --region ap-south-1 `
  --key '{"licenseKey":{"S":"PDM-XXXX-XXXX-XXXX-XXXX"}}' `
  --update-expression "SET #s = :a" `
  --expression-attribute-names '{"#s":"status"}' `
  --expression-attribute-values '{":a":{"S":"active"}}'
```

**Clear a stuck activation** (e.g. customer swapped PCs, license bound to old fingerprint):
```powershell
aws dynamodb update-item --table-name pdm-licenses --region ap-south-1 `
  --key '{"licenseKey":{"S":"PDM-XXXX-XXXX-XXXX-XXXX"}}' `
  --update-expression "SET activations = :empty" `
  --expression-attribute-values '{":empty":{"M":{}}}'
```

**Test the live endpoints**:
```powershell
$base = "https://pgwoailzqa.execute-api.ap-south-1.amazonaws.com"
$fp = "00112233445566778899AABBCCDDEEFF"

# Trial anchor
Invoke-RestMethod -Method Post -Uri "$base/trial" `
  -ContentType "application/json" -Body (@{fingerprint=$fp}|ConvertTo-Json)

# Activate
Invoke-RestMethod -Method Post -Uri "$base/activate" `
  -ContentType "application/json" `
  -Body (@{licenseKey="PDM-XXXX-XXXX-XXXX-XXXX";fingerprint=$fp}|ConvertTo-Json)
```

**Tear down the whole backend** (including the DynamoDB table):
```powershell
aws cloudformation delete-stack --stack-name pdm-licensing --region ap-south-1
# The SSM signing key parameter and the S3 deploy bucket are NOT auto-deleted; remove manually if you're done for good.
```

## Browser extension

See [BROWSER-EXTENSION.md](BROWSER-EXTENSION.md) for step-by-step install. Quick commands:

```powershell
# After loading the unpacked extension (chrome://extensions), register the native host:
./browser-extension/install-native-host.ps1 `
  -HostExe "$env:LOCALAPPDATA\Perfect Download Manager\pdm-native-host.exe" `
  -ExtensionIds "<your-extension-id>"

# To unregister:
./browser-extension/install-native-host.ps1 -HostExe x -Uninstall
```

## Git

```powershell
# What am I about to commit?
git status --short

# Commit locally (no push - remote isn't configured yet)
git add .
git commit -m "message"

# Log
git log --oneline
```
