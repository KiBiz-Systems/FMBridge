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

## Publishing a release

Builds are **not** committed to the repo; they live on GitHub Releases.
`.github/workflows/release.yml` runs on a `v*` tag push: it fails fast unless the tag equals
package.json's `version`, runs `npm test`, packages, and uploads the .vsix twice — as
`fm-bridge-<version>.vsix` (the archive copy) and as `fm-bridge.vsix`, a version-free name so
`https://github.com/KiBiz-Systems/FMBridge/releases/latest/download/fm-bridge.vsix` always
resolves to the newest build. README links to that URL, so a release needs no README edit.

```
npm run sync-templates && npm test   # fold in learnings, verify (do this BEFORE tagging)
git tag v0.1.22 && git push origin main --tags
```

Re-running a tag's build (e.g. after a failed upload) is `workflow_dispatch` from the Actions tab
with the tag name — it uploads with `--clobber` when the release already exists.

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
   **Copy CONFIGURED steps when capturing for the starter set.** FM omits children whose option
   is unset, so a copy of a freshly-dragged step teaches a template with no slot for the
   parameter that matters. `xmlToText` guards against this at runtime (a leaner paste never
   clobbers a richer stored template — the `keepPrev` label-superset check), but through 0.1.20
   `sync-templates.js` overwrote unconditionally: that is how the shipped `Insert from URL` lost
   its URL and cURL-options slots and `Close Window` lost `Name`. The script now applies the same
   superset rule and logs what it kept.
3. **Raw passthrough**: complex steps (Insert from URL, saved find/sort criteria, Go to Layout…)
   become `#fmxml <xml>` lines (or `#fmxml64 Name <base64>` when the XML is multi-line) that
   paste back byte-identical but aren't text-editable.

Learned-template caveat: templates refill slots by parameter *label*, so a step whose meaning
depends on child order with duplicate labels could rebuild incorrectly (none known in practice —
but keep it in mind when touching `slotElement`/`fillTemplate`).

## Clipboard access (platform-specific, both directions)

**Writing (editor → FM) needs FileMaker's private clipboard format on BOTH desktop platforms —
do not "simplify" it to one `writeText` call.** FileMaker pastes ONLY from its private format
and silently ignores a text-only clipboard, so the copy command reports success (toast and all)
while Script Workspace refuses the paste. This was fixed for macOS in 0.1.19 and for Windows in
0.1.21 — the earlier claim in this file that "FileMaker for Windows pastes happily from a
plain-text clipboard" was wrong, and cost a release.

- `writeFmClipboardMac()` sets an AppleScript raw-data literal `«data XMSS<uppercase hex>»` via
  `osascript`, sent on **stdin** rather than `-e` (hex doubles the payload; a large script
  overruns the argv limit). AppleScript's `set the clipboard to` sets a *single* flavor, so on
  success the text flavor is replaced, not augmented.
- `writeFmClipboardWindows()` shells out to `write-fm-clipboard.ps1` (PowerShell, `-STA`), the
  mirror of `read-fm-clipboard.ps1`. The XML goes in as UTF-8 bytes on **stdin** (same argv-size
  reason) and one `DataObject` publishes both `Mac-XMSS` (a `MemoryStream`, whose bytes WinForms
  writes verbatim — any other object type would get .NET serialization metadata wrapped around
  it) and the text flavor, so on Windows the text clipboard survives.

`textToXml` only ever emits top-level `<Step>` objects, so `XMSS`/`Mac-XMSS` is always the
correct class on the write side (`XMSC` would be for whole scripts). `writeText` still runs
first on both platforms so a failed native write leaves the XML on the clipboard as text
instead of nothing.

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

**Parsing is deliberately more permissive than emission** (added 0.1.21, after 0.1.20 rejected
lines that FileMaker itself displays). `xmlToText` still emits the one canonical labeled form, so
round-trip stability is unaffected, but `textToXml` also accepts:
- **Unlabeled positional values** — `Allow User Abort [ Off ]`, FM's own display syntax, not just
  `[ Set: Off ]`. Only arguments with no `Label: ` prefix are placed positionally, and On/Off
  slots reject non-booleans, so a stray value can't land in a toggle. An argument that *does*
  carry an unknown label is still an error — that means the template is missing a parameter, and
  silently dropping it would change the step (`looksLabeled` deliberately does not treat
  `Products::Name` or `https://x` as labeled).
- **Case-insensitive step names** — `Set Field by Name` resolves to `Set Field By Name`.
  `matchStepName`'s normalizer must preserve length; the args are sliced off by name length.
- **Omitted optional children** — `fillTemplate` drops the whole element (`dropSlotElement`),
  then a lone `{{i}}` that is a child in its own right (`dropBareSlot`, for `field` and bare
  `Calculation` slots), then the bare attribute. Order matters: `dropBareSlot` before
  `dropSlotElement` would leave an empty `<CURLOptions></CURLOptions>` behind.

An unrecognized step name gets a "did you mean" from `closestStepName` (edit distance, since case
and punctuation already resolve above, so what is left is a real typo).

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
