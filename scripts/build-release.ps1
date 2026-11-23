# Build the signed Windows installer locally (same output as the Release workflow).
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Test   # keep the UI-test hook
#
# The updater signing key is read from %USERPROFILE%\.tauri\taara-editor.key
# (+ .key.password.txt) unless TAURI_SIGNING_PRIVATE_KEY is already set.
param([switch]$Test)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $key = Join-Path $env:USERPROFILE ".tauri\taara-editor.key"
    if (-not (Test-Path $key)) {
        throw "Signing key not found: $key. Set TAURI_SIGNING_PRIVATE_KEY or generate one with: npx tauri signer generate -w `"$key`""
    }
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $key -Raw
    $pw = "$key.password.txt"
    if (Test-Path $pw) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $pw -Raw).Trim() }
}

if ($Test) { $env:VITE_TAARA_TEST = "1" } else { Remove-Item Env:VITE_TAARA_TEST -ErrorAction SilentlyContinue }

npm run tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-ChildItem src-tauri\target\release\bundle\nsis | Format-Table Name, Length
