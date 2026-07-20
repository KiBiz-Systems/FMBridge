# Installs the newest packaged .vsix into Antigravity IDE (the user's VS Code fork).
# The plain `code` CLI targets the wrong editor, so the IDE's own CLI is used.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$vsix = Get-ChildItem -Path $root -Filter 'fm-bridge-*.vsix' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -eq $vsix) {
    Write-Error "No fm-bridge-*.vsix found in $root - run 'npm run package' first."
}

$ide = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\bin\antigravity-ide.cmd'
if (-not (Test-Path $ide)) {
    Write-Error "Antigravity IDE CLI not found at $ide"
}

Write-Host "Installing $($vsix.Name) into Antigravity IDE..."
& $ide --install-extension $vsix.FullName
Write-Host "Done. Run 'Developer: Reload Window' in the IDE to activate the new build."
