#!/usr/bin/env bash
# macOS/Linux counterpart to install.ps1: installs the newest packaged .vsix into
# Antigravity IDE. Same reasoning as on Windows — the plain `code` CLI targets a
# different editor, so the IDE's own CLI is used. Override with FM_BRIDGE_IDE=/path/to/cli.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Newest by mtime, matching install.ps1's Sort-Object LastWriteTime -Descending.
vsix="$(ls -t "$root"/fm-bridge-*.vsix 2>/dev/null | head -1 || true)"
if [ -z "$vsix" ]; then
  echo "No fm-bridge-*.vsix found in $root - run 'npm run package' first." >&2
  exit 1
fi

# On macOS the CLI is symlinked into /usr/local/bin by the IDE's "Install
# command in PATH"; fall back to the app bundle if that was never run.
ide="${FM_BRIDGE_IDE:-}"
if [ -z "$ide" ]; then
  for cand in \
    "$(command -v antigravity-ide 2>/dev/null || true)" \
    "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
    "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity"
  do
    if [ -n "$cand" ] && [ -x "$cand" ]; then ide="$cand"; break; fi
  done
fi
if [ -z "$ide" ]; then
  echo "Antigravity IDE CLI not found. Run 'Install 'antigravity-ide' command in PATH'" >&2
  echo "from the IDE's command palette, or set FM_BRIDGE_IDE=/path/to/cli." >&2
  exit 1
fi

echo "Installing $(basename "$vsix") into $ide..."
# The CLI can print 'FATAL ERROR: v8::ToLocalChecked' while exiting *after* a
# successful install (see CLAUDE.md), so a nonzero exit here is not conclusive.
"$ide" --install-extension "$vsix" || echo "(CLI exited nonzero - check for the 'successfully installed' line above)"
echo "Done. Run 'Developer: Reload Window' in the IDE to activate the new build."
