# FM Bridge

Local VS Code extension bridging FileMaker Pro's clipboard XML and readable `.fmscript` text.
No server, no account, no telemetry. Everything runs locally.

## Install

Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), search **FM Bridge** or
**FileMaker**, and click **Install**. Available on both the
[VS Code Marketplace](https://marketplace.visualstudio.com/) (VS Code) and
[Open VSX](https://open-vsx.org/) (Cursor, VSCodium, Windsurf, Antigravity, and other forks).

Coverage for ~220 script steps is bundled in, so it works immediately with no setup.

> **Platform note:** full clipboard reading (FileMaker's private clipboard formats) is
> **Windows-only** — it shells out to PowerShell. On macOS/Linux, `Ctrl+Alt+V` still works when
> FileMaker's clipboard XML is available as plain text; otherwise it falls back to a normal paste.

## Shortcuts

| Keys | Command | Direction |
|---|---|---|
| `Ctrl+Alt+V` | Paste FileMaker Clipboard as Script Text | FileMaker → editor |
| `Ctrl+Alt+B` | Copy as FileMaker XML | editor → FileMaker (in `.fmscript` files) |

**Workflow:** copy steps in FileMaker's Script Workspace (`Ctrl+C`) → `Ctrl+Alt+V` in VS Code
to get readable text → edit (or let AI edit) → select nothing (whole file) or select lines →
`Ctrl+Alt+B` → switch to Script Workspace → `Ctrl+V`.

If the clipboard isn't FileMaker XML, `Ctrl+Alt+V` falls back to a normal paste.

## How coverage works

1. **Built-ins** — ~20 step types with hand-verified XML shapes (Set Variable, Set Field,
   If/Else/End If, Loop/Exit Loop If/End Loop, Perform Script, Show Custom Dialog,
   Perform Find, Go to Record, Exit Script, Pause, Enter Find Mode, Set Error Capture, …).
2. **Learned templates** — any other step whose XML children are simple (calculations, flags,
   typed values, attribute tags, field refs) is learned automatically the first time you paste
   it *from* FileMaker. The skeleton is cached in `.fmbridge/templates.json` in your workspace
   and reused when converting text back to XML. The extension also ships with a **starter set**
   of pre-learned steps (`lib/starter-templates.json`) that works out of the box; anything you
   learn locally overrides or extends it. To bootstrap broad coverage fast: make a throwaway
   "kitchen sink" script in FileMaker with every step you use, copy it, `Ctrl+Alt+V` once.
3. **Raw passthrough** — complex steps (Insert from URL, saved find criteria, Go to Layout,
   Sort with saved order, …) become `#fmxml <Step …>` (or `#fmxml64 Name <base64>` when
   multi-line) lines. They paste back into FileMaker *byte-identical*, so nothing is ever lost —
   you just can't edit those steps' innards as plain text.

## Text format

- One step per line, FileMaker's own display syntax: `Set Variable [ $x ; Value: … ]`
- 4-space indent inside `If`/`Else`/`Loop` blocks (indentation is cosmetic; ignored on rebuild)
- `# text` = comment step, blank line = blank comment step
- `// ` prefix = disabled step
- `Label: #blob <base64>` = sealed envelope: opaque data (embedded print settings, import
  field maps) compressed and carried inside an otherwise editable line; restored byte-exact
  on rebuild. Never hand-edit the base64 — omit the whole parameter to mean "option not set".
- `#fmxml …` / `#fmxml64 …` = raw XML passthrough (see above)

## Autocomplete (in `.fmscript` files)

- Script step names (built-ins insert full templates, learned ones insert their parameter labels)
- FileMaker calculation functions with signatures, `Get ( Flag )` variants
- `$var` / `$$var` names already used in the file
- `"ScriptName"` completions from `.fmscript` files in your workspace

## Build, test, deploy

Plain JavaScript, zero runtime dependencies. Node.js is the only requirement (vsce is fetched
on demand via `npx`).

```
npm test               # round-trip stability check (text -> XML -> text -> XML) on real fixtures
npm run sync-templates # fold this workspace's learned templates into the bundled starter set
npm run package        # build fm-bridge-<version>.vsix
npm run install-ide    # install the newest .vsix into Antigravity IDE
npm run deploy         # all of the above in order
```

After installing, run **Developer: Reload Window** in the IDE. Bump `version` in `package.json`
on every rebuild, or the IDE may keep serving the cached old build.

The target editor is **Antigravity IDE** (a VS Code fork) — its CLI lives at
`%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd`; the plain `code` CLI targets
the wrong editor. The CLI sometimes prints a scary `FATAL ERROR: v8::ToLocalChecked` while
exiting *after* a successful install — ignore it if the "successfully installed" line appeared.

Test fixtures live in `test/fixtures/`: a real `.fmscript` plus a `templates.json` of learned
step skeletons captured from actual FileMaker pastes. To test against another script:
`node test/roundtrip.test.js path\to\file.fmscript`. After changing converter code in `lib/`,
`npm test` is the round-trip check that must stay green.

## Known limitations

- Steps that are neither built-in nor learned can't be *authored* from scratch in text —
  copy one instance from FileMaker first so the template gets learned.
- Learned templates refill by parameter label; a step whose meaning depends on child *order*
  with duplicate labels could rebuild incorrectly (none known in practice).
- `Perform Find [ Restore ]` / saved sort orders can't be reconstructed from text — they
  round-trip via `#fmxml` passthrough only.
- FileMaker resolves pasted references by name: `Perform Script`/`Go to Layout` targets and
  field names must exist (and match case) in the target file; verify after paste.
- Whole-script copies paste back as *steps* into an open script, not as a new script in the
  script list.
