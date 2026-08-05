# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FM Bridge is a local VS Code extension (plain JavaScript, zero runtime dependencies, no build step
for the code itself) that converts between FileMaker Pro's clipboard XML (`FMXMLSNIPPET`) and
readable `.fmscript` text. `Ctrl+Alt+V` pastes FileMaker clipboard XML as script text;
`Ctrl+Alt+B` converts a `.fmscript` selection (or whole file) back to FileMaker XML on the
clipboard. It exists because hand-authoring FMXMLSNIPPET XML by guesswork was unreliable
(FileMaker silently drops children it doesn't recognize, producing steps with empty parameters).

It was extracted from the IDF Search FileMaker project (`d:\Kibiz solutions\Learning\IDF Search`),
which still uses it daily; `.fmscript` files there under `Scripts/` are authored with this tool.

## Commands

```
npm test             # round-trip stability test (see below) — must stay green after lib/ changes
npm run package      # build fm-bridge-<version>.vsix via vsce (fetched on demand by npx)
npm run install-ide  # install newest .vsix into Antigravity IDE (scripts/install.ps1)
npm run deploy       # test + package + install-ide
node test/roundtrip.test.js path\to\file.fmscript   # test against a specific script
```

**Always bump `version` in package.json before packaging** — the IDE may keep serving a cached
old build otherwise.

## Deployment environment (non-obvious, learned the hard way)

- The target editor is **Antigravity IDE** (a VS Code fork), NOT plain VS Code. The `code` CLI on
  PATH targets plain VS Code — the wrong editor; installs via it "succeed" but land in an editor
  the user doesn't use. Correct CLI: `%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd`
  (fails under Git Bash due to the space in the path — call it from PowerShell, as
  `scripts/install.ps1` does).
- Manually copying the folder into `~/.vscode/extensions` does not register the extension at all.
- The Antigravity CLI often prints `FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal` while
  exiting *after* a successful install. If the "successfully installed" line appeared, ignore it.
- After installing, the user must run **Developer: Reload Window**.
- Registered extension id: `kibiz.fm-bridge`. `activationEvents: ["onLanguage:fmscript"]` is
  required — without it, autocomplete doesn't register until a command is first run.

## Architecture: three-tier step coverage

Code layout: `extension.js` (VS Code glue: commands, keybindings, completions, template store I/O),
`lib/steps.js` (the converters — `xmlToText(xml, store)` / `textToXml(text, store)`, both pure
functions taking a `{ templates }` store), `lib/xmlutil.js` (CDATA masking, entity handling,
attr/element parsing), `lib/fmdata.js` (FM function/Get-flag data for autocomplete).

1. **Built-ins** (`BUILTINS` in lib/steps.js): ~20 hand-verified bijective formatters for the
   most common steps (Set Variable, Set Field, If/Else/End If, Loop/Exit Loop If/End Loop,
   Perform Script, Show Custom Dialog, Perform Find, Go to Record, Exit Script, Pause, Enter
   Find Mode, Sort Records, Set Error Capture, Comment, bare steps).
2. **Learned templates**: any other step whose children decompose into simple shapes
   (calculations, state flags, single/multi-attribute tags, attr+text tags, field refs,
   containers — recursively, up to 5 levels) is learned automatically every time it's pasted
   FROM FileMaker (**last paste wins** — FM omits unset children, so the freshest copy is the
   freshest ground truth); skeletons are cached per-workspace in `.fmbridge/templates.json`
   (the copy in `test/fixtures/` here is a frozen snapshot for testing, not the live cache).
   `id` attributes, empty values, and whitespace-sensitive values (tab delimiters) are frozen
   verbatim in the skeleton, never slotted. Duplicate labels decline to passthrough.
   After learning, that step type can be authored from scratch in text. textToXml falls back
   builtin → learned template when a builtin rejects the given args, and errors on a labeled
   arg the template has no slot for (means the template was learned from a leaner instance —
   re-paste from FileMaker to refresh it).
   A **starter set** (`lib/starter-templates.json`, captured from real FileMaker pastes) ships
   inside the .vsix; `loadStore()` in extension.js merges it under the workspace's own
   templates (workspace wins), and `saveStore()` writes only the diff from the starter set.
   `npm run sync-templates` folds this workspace's learnings into the starter file — run it
   (it's part of `npm run deploy`) before packaging a release.
3. **Raw passthrough**: complex steps (Insert from URL, saved find/sort criteria, Go to Layout…)
   become `#fmxml <xml>` lines (or `#fmxml64 Name <base64>` when the XML is multi-line) that
   paste back byte-identical but aren't text-editable.

Learned-template caveat: templates refill slots by parameter *label*, so a step whose meaning
depends on child order with duplicate labels could rebuild incorrectly (none known in practice —
but keep it in mind when touching `slotElement`/`fillTemplate`).

## Clipboard access (platform-specific, both directions)

**Writing (editor → FM) is asymmetric between platforms — do not "simplify" it to one
`writeText` call.** FileMaker for **Windows** pastes happily from a plain-text
`<fmxmlsnippet>` clipboard, but FileMaker for **macOS** pastes ONLY from its private
pasteboard type and silently ignores a text clipboard — `Cmd+Alt+B` appeared to succeed
(toast and all) while Script Workspace refused the paste. `writeFmClipboardMac()` therefore
sets an AppleScript raw-data literal `«data XMSS<uppercase hex>»` via `osascript`, sent on
**stdin** rather than `-e` (hex doubles the payload; a large script overruns the argv limit).
`textToXml` only ever emits top-level `<Step>` objects, so `XMSS` is always the correct class
on the write side (`XMSC` would be for whole scripts). `writeText` still runs first so a
failed native write leaves the XML on the clipboard as text instead of nothing — note that
AppleScript's `set the clipboard to` sets a *single* flavor, so on success the text flavor is
replaced, not augmented.

## Clipboard reading (two paths)

`Ctrl+Alt+V` first checks the plain-text clipboard for `<fmxmlsnippet`. If absent, it shells out
to `read-fm-clipboard.ps1` (PowerShell, must run `-STA`) which reads FileMaker's *private*
clipboard formats (`Mac-XMSS` script steps, `Mac-XMSC` scripts, `Mac-XMTB`/`Mac-XMFD`/`Mac-XMFN`/
`Mac-XMVL` for tables/fields/functions/value lists) — UTF-8 bytes, sometimes with a 4-byte length
header before the XML. If neither path finds a snippet, the command degrades to a normal paste,
so the keybinding is always safe to press.

## FileMaker XML facts that shape the code (do not "simplify" these away)

- **FileMaker resolves pasted steps by NAME first, then the `id` attribute.** Comment steps are
  named `# (comment)` in FM's XML; emitting `name="Comment"` once made FM paste comments as
  Perform Script (id 1). Learned templates store the real step `id` and raw `xmlName` (some real
  step names carry a trailing space, e.g. `"Configure RAG Account "`) and re-emit both.
- **FM's paste parser silently drops old-schema children.** Several steps have an old export
  shape and a modern one (e.g. Go to Record: `<Value type="Which">First</Value>` vs
  `<RowPageLocation value="First"/>`; dialogs: `<Text>/<Button1..3>` vs calc-wrapped
  `<Title>/<Message>/<Buttons>`; Enter Find Mode: `<PauseFind>` vs `<Pause state/>`). Builtins
  READ both shapes but EMIT only the modern shapes.
- `<Restore state="False"/>` is stamped on nearly every step by modern FM and is treated as
  droppable noise; `Restore state="True"` is meaningful.
- Multi-line calculations (with embedded `//` comments, string literals containing brackets or
  newlines) require the logical-line grouping in textToXml (`scanLine`: string-aware
  bracket-depth scanner); the emitter puts a closing `]` on its own line when a calc ends
  inside a `//` comment.
- CDATA is masked (`xmlutil.maskCdata`) before any regex/whitespace handling and unmasked at
  the end — never run whitespace collapsing over raw XML with live CDATA.

## Text grammar (what `.fmscript` files must look like)

FileMaker's own display syntax, one step per line: `Set Variable [ $x ; Value: … ]` with
` ; `-separated labeled params (`Value:`, `Parameter:`, `Title:`, `Message:`, `Buttons:`,
`Text Result:`, `Duration (seconds):`, `Exit after last:` …). 4-space indent inside If/Loop
blocks (cosmetic; ignored on rebuild). `# text` = comment step, blank line = blank comment,
`// ` prefix = disabled step, `#fmxml`/`#fmxml64` = raw passthrough,
`Label: #blob <base64>` = deflated+base64 sealed envelope for a child element no slot rule
understands (print-driver PlatformData, import field maps) — inflated verbatim on rebuild,
omitted = option not set. Straight quotes are emitted; curly quotes are accepted on parse. A step type that is neither built-in nor learned
cannot be authored from scratch — copy one instance from FileMaker first so it gets learned.

## Testing

`npm test` runs `test/roundtrip.test.js` in plain Node (no VS Code): text → XML → text → XML on
`test/fixtures/sample.fmscript` (a real 26-step production script) with
`test/fixtures/templates.json`, asserting stability (canonical text and XML are fixed points),
zero errors, and step-count preservation. The historical bar for converter changes is: round-trip
must be stable AND the rebuilt XML should pass the `validate_fmxmlsnippet` KiBuild MCP tool
(available in FileMaker project workspaces). The ultimate test is a real paste into FileMaker's
Script Workspace — schema guesses that were never verified against a real FM copy have been wrong
before (see the dialog and Go to Record incidents above), so when adding or changing a step's XML
shape, get a real copied instance from FileMaker as ground truth.
