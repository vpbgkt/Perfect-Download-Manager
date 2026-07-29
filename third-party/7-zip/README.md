# Bundled 7-Zip console engine

PDM's "Extract and open" feature extracts downloaded archives (ZIP, RAR, 7z, tarballs, …) by
driving the **7-Zip console engine** as a hidden child process — no 7-Zip window is ever shown.
These binaries are bundled with PDM so users don't need 7-Zip installed.

## Files (not committed to git)

- `7z.exe` — the console engine
- `7z.dll` — codecs (includes RAR extraction)
- `License.txt` — 7-Zip license text

They are **not** stored in the repo. Fetch the pinned version with:

```powershell
./build/fetch-7zip.ps1
```

`build/publish-aot-dist.ps1` runs this automatically if the binaries are missing, then copies them
into the app under `tools/7-zip/`. The installer's recursive file harvest ships that folder.

## Pinned version

7-Zip **24.09** (x64). Bump the `-Version` in `build/fetch-7zip.ps1` to update.

## Licensing

7-Zip is free software. `7z.exe`/`7z.dll` are licensed under **LGPL-2.1**; the RAR extraction code
is under the **unRAR license** (extraction is permitted; using the code to build a RAR *compressor*
is not — PDM only extracts). Obligations we meet:

- Ship `License.txt` with the app (included in `tools/7-zip/`), and list 7-Zip in the app's
  third-party notices.
- Keep `7z.dll` a loose, replaceable file (LGPL) — it is, under `tools/7-zip/`.
- Do not rebrand 7-Zip or remove its copyright.

Official signed binaries come from <https://www.7-zip.org>.
