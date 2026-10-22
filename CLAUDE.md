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
package.json's `version`, runs `npm test`, packages, and uploads:

- `fm-bridge-<version>.vsix` — the archive copy
- `fm-bridge-windows.vsix` — this build; README's Windows link
- `fm-bridge.vsix` — this build; the pre-split name, kept so old links still resolve
- `fm-bridge-mac.vsix` — **copied forward from the previous latest release**, not this build.
  README's macOS link points here, and macOS deliberately stays on the last build verified on a
  Mac (0.1.21 when the split was made, 2026-10-22). To move macOS to a new build, run the
  workflow manually (`workflow_dispatch`) with the tag and `update_mac` ticked.

README links to `releases/latest/download/fm-bridge-{mac,windows}.vsix`, so a release needs no
README edit — but a release missing either file 404s that platform's link, which is why the
workflow fails rather than publish without a Mac file to carry forward.

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
while Script Workspace refuses the paste. This was fixed for macOS in 0.1.19. Windows took three
tries: 0.1.21 (`[System.Windows.Forms.Clipboard]::SetDataObject` with a `MemoryStream`) still
pasted nothing despite .NET reading its own write back successfully — WinForms' `DataObject`
marshals a `Stream` for a non-native format name through its own COM plumbing, which isn't
guaranteed to hand the OS a plain `HGLOBAL` a native Win32 reader can trust. 0.1.23 switched to
raw Win32 `OpenClipboard`/`SetClipboardData` (P/Invoke) to remove that ambiguity — still nothing
pasted. The real bug only surfaced from a hex dump of a REAL FileMaker-for-Windows copy (there's
a debug command for this, see below): the payload shape itself was wrong, not the delivery
mechanism. Fixed in 0.1.24. The earlier claim in this file that "FileMaker for Windows pastes
happily from a plain-text clipboard" was wrong from the start, and cost a release before that too.

- `writeFmClipboardMac()` sets an AppleScript raw-data literal `«data XMSS<uppercase hex>»` via
  `osascript`, sent on **stdin** rather than `-e` (hex doubles the payload; a large script
  overruns the argv limit). AppleScript's `set the clipboard to` sets a *single* flavor, so on
  success the text flavor is replaced, not augmented. The payload here is bare XML, no header —
  see the Windows contrast below.
- `writeFmClipboardWindows()` shells out to `write-fm-clipboard.ps1` (PowerShell, `-STA`), the
  mirror of `read-fm-clipboard.ps1`. The XML goes in as UTF-8 bytes on **stdin** (same argv-size
  reason). The script talks straight to the Win32 clipboard API (`OpenClipboard`/`GlobalAlloc`/
  `SetClipboardData`/`CloseClipboard` via P/Invoke) rather than any .NET clipboard abstraction, to
  guarantee FileMaker sees byte-identical native memory — `CF_UNICODETEXT` first (so the text
  clipboard survives, matching the Mac behavior above) and only then `Mac-XMSS`.
  **`Mac-XMSS` on Windows is NOT bare XML.** A hex dump of a real FileMaker-for-Windows copy
  showed the payload is **`[4-byte little-endian length][UTF-8 XML]`** — header bytes
  `74 27 00 00` decoded to `0x00002774` = 10100, and the buffer was exactly 10104 bytes
  (10100 + the 4 header bytes) with `<fmxmlsnippet...` starting right at offset 4. FileMaker's
  Windows paste routine trusts that header instead of scanning for the XML start tag (unlike our
  own `read-fm-clipboard.ps1`/`extractSnippet`, which tolerate the header only by locating the
  `<fmxmlsnippet` substring — they never needed to decode it). Best guess why Mac doesn't need
  this: `GlobalAlloc`/`GlobalSize` round allocations up to a granularity boundary, so the Win32
  buffer's reported size can exceed the real payload size by a few bytes — FileMaker can't trust
  `GlobalSize()` alone to find the end of the XML, so it embeds an explicit length it can trust.
  `NSPasteboard` on Mac carries each item's exact byte length as OS-level metadata outside the
  payload, so that workaround was never needed there. **Do not "unify" the two write functions**
  — the OS API, invocation mechanism, and payload shape are all genuinely different per platform;
  a shared abstraction would risk leaking the length header into Mac's write or dropping it from
  Windows'.
- `dumpClipboardDebug()` / `dump-clipboard.ps1` (command: "FM Bridge: Dump Clipboard Diagnostics")
  is a diagnostic-only command (Windows only) that hex-dumps whatever is currently on the
  clipboard for every known FileMaker private format. This is how the length-header bug above was
  actually found — comparing a real FileMaker copy's bytes against what FM Bridge wrote, rather
  than guessing at the wire format blind. Reach for it first the next time a Windows clipboard
  write looks like it succeeded but nothing pastes.

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
