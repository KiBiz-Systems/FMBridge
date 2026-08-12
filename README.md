# FM Bridge — FileMaker Script ⇄ Text

A local VS Code extension that bridges FileMaker Pro's clipboard XML (`FMXMLSNIPPET`) and
readable `.fmscript` text. Copy script steps out of FileMaker and edit them as plain text — by
hand or with an AI assistant — then paste them straight back.

No server, no account, no telemetry, no runtime dependencies. Everything runs locally.

**Works on Windows and macOS from the same build.** Both clipboard directions are verified
against FileMaker Pro on each platform.

## Install

Download the latest build — [**fm-bridge.vsix**](https://github.com/KiBiz-Systems/FMBridge/releases/latest/download/fm-bridge.vsix)
— and install it with your editor's CLI:

```sh
curl -LO https://github.com/KiBiz-Systems/FMBridge/releases/latest/download/fm-bridge.vsix

# VS Code
code --install-extension fm-bridge.vsix

# Antigravity IDE
antigravity-ide --install-extension fm-bridge.vsix

# Cursor / VSCodium / Windsurf and other forks
cursor --install-extension fm-bridge.vsix
```

Or from the editor UI: **Extensions** view → `…` menu → **Install from VSIX…**

That download link always serves the newest release. Earlier builds, and what changed in each,
are on the [releases page](https://github.com/KiBiz-Systems/FMBridge/releases).

Then run **Developer: Reload Window**. This step is required — installing a `.vsix` does not
hot-swap an extension that is already running.

The same file installs on Windows and macOS; platform differences are handled at runtime.
Coverage for 216 script steps is bundled in, so it works immediately with no setup.

> **Requirements:** VS Code 1.80+ (or any fork at that API level) and FileMaker Pro. Node.js is
> only needed to build the extension yourself, not to use it.

## Shortcuts

| Windows | macOS | Command | Direction |
|---|---|---|---|
| `Ctrl+Alt+V` | `Cmd+Option+V` | Paste FileMaker Clipboard as Script Text | FileMaker → editor |
| `Ctrl+Alt+B` | `Cmd+Option+B` | Copy as FileMaker XML | editor → FileMaker |

Both are also in the Command Palette as **FM Bridge: …**. The copy-out shortcut is active only
in `.fmscript` files; the paste shortcut works anywhere and falls back to an ordinary paste when
the clipboard is not FileMaker content, so it is always safe to press.

### Workflow

1. In FileMaker's Script Workspace, select steps and copy (`Ctrl+C` / `Cmd+C`)
2. In your editor, open a `.fmscript` file and press `Ctrl+Alt+V` / `Cmd+Option+V`
3. Edit the text — or let an AI assistant edit it
4. Select lines (or nothing, for the whole file) and press `Ctrl+Alt+B` / `Cmd+Option+B`
5. Switch to Script Workspace and paste (`Ctrl+V` / `Cmd+V`)

## Script step coverage

Coverage is measured against FileMaker Pro 2025 (v22), and every bundled template was captured
from a real FileMaker copy rather than written by hand.

| Tier | Count | Editable as text? | Round-trips? |
|---|---|---|---|
| **Built-in** — hand-verified, bijective formatters | 26 | ✅ full | ✅ |
| **Pre-learned templates** — bundled starter set | 192 | ✅ full | ✅ |
| **Authorable total** (built-in + templates) | **216** | ✅ | ✅ |
| **Recognised names** (adds autocomplete-only steps) | **227** | after one copy | ✅ |
| **Raw passthrough** — anything else | unlimited | ❌ opaque line | ✅ byte-identical |

**Nothing is ever lost.** A step FM Bridge cannot model as text becomes a `#fmxml` line that
pastes back byte-identical. The only cost is that you cannot edit that step's internals as text.

### How the three tiers work

1. **Built-ins** — 26 step types with hand-verified XML shapes, covering the control flow and
   data steps that dominate real scripts: `Set Variable`, `Set Field`, `If` / `Else If` / `Else` /
   `End If`, `Loop` / `Exit Loop If` / `End Loop`, `Perform Script`, `Show Custom Dialog`,
   `Enter Find Mode`, `Perform Find`, `Go to Record/Request/Page`, `Sort Records`, `Exit Script`,
   `Halt Script`, `Pause/Resume Script`, `Set Error Capture`, `Freeze Window`, `Show All Records`,
   `New Record/Request`, `Duplicate Record/Request`, `Omit Record`, `Open Record/Request`, and
   comments.

2. **Learned templates** — any other step whose XML children are simple shapes (calculations,
   state flags, typed values, attribute tags, field references, nested containers) is learned
   automatically the first time you paste it *from* FileMaker, then reused when converting text
   back to XML. 192 such templates ship pre-learned in `lib/starter-templates.json`; anything you
   learn locally is cached in `.fmbridge/templates.json` in your workspace and overrides the
   bundled set.

   Because FileMaker omits children that are not set, the freshest copy is the best ground truth —
   so **the most recent paste wins**. If a step reports an unknown parameter, re-copy a fully
   configured instance from FileMaker to refresh its template.

   To bootstrap broad coverage fast, build a throwaway "kitchen sink" script in FileMaker
   containing every step you use, copy it, and paste once.

3. **Raw passthrough** — genuinely complex steps (`Insert from URL` with cURL options, saved find
   criteria, `Go to Layout`, saved sort orders, print setups) become `#fmxml <Step …>` lines, or
   `#fmxml64 Name <base64>` when the XML spans multiple lines.

### Steps introduced in newer FileMaker versions

FM Bridge is not pinned to a FileMaker version. It reads whatever `FMXMLSNIPPET` your copy of
FileMaker produces, so steps added in v22 or later — including AI/RAG steps such as
`Configure AI Account` and `Perform Semantic Find` — are learned from a single copy and become
authorable, with no update to this extension required. Steps too complex to model still
round-trip losslessly via passthrough.

## Autocomplete

Available in `.fmscript` files:

- **Script steps** — built-ins insert a full parameter template; learned steps insert their real
  parameter labels
- **136 calculation functions** with signatures
- **94 `Get ( … )` flags**
- **`$var` / `$$var`** names already used in the file
- **`"ScriptName"`** completions drawn from `.fmscript` files in your workspace

## Text format

FileMaker's own display syntax, one step per line:

```
# Fetch the contact and email them
Set Variable [ $email ; Value: Contacts::Email ]
If [ not IsEmpty ( $email ) ]
    Send Mail [ NoInteract: On ; To: $email ; Subject: "Hello" ; SendViaSMTP: On ]
End If
Exit Script [ Text Result: "OK" ]
```

- ` ; `-separated labeled parameters (`Value:`, `Parameter:`, `Title:`, `Message:`, `Buttons:`,
  `Text Result:`, `Duration (seconds):` …); an omitted parameter means "option not set"
- 4-space indent inside `If` / `Else` / `Loop` blocks — cosmetic, ignored on rebuild
- `# text` = comment step; a blank line = blank comment step
- `// ` prefix = disabled step
- Multi-line calculations are supported, including embedded `//` comments and string literals
  containing brackets or newlines
- `Label: #blob <base64>` = sealed envelope carrying opaque binary settings (embedded print
  setups, import field maps) inside an otherwise editable line; restored byte-exact on rebuild.
  Never hand-edit the base64 — omit the whole parameter to mean "not set".
- `#fmxml …` / `#fmxml64 …` = raw XML passthrough
- Straight quotes are emitted; curly quotes are accepted on input

Sealed `#blob` and `#fmxml` payloads are visually collapsed to a small badge in the editor and
revealed when your cursor enters the line.

## Platform notes

FileMaker exchanges script steps through *private* clipboard formats, not plain text, so each OS
needs its own path. This is handled automatically:

| | Read (FileMaker → editor) | Write (editor → FileMaker) |
|---|---|---|
| **Windows** | PowerShell reads the `Mac-XMSS` clipboard format | PowerShell writes the `Mac-XMSS` clipboard format, plus plain text |
| **macOS** | `osascript` reads the `XMSS` pasteboard type | `osascript` writes the `XMSS` pasteboard type |
| **Linux** | plain text only, if FileMaker XML is already on the clipboard | not supported |

The private write path is not optional on either desktop OS: FileMaker pastes **only** from its
own clipboard format and ignores a text-only clipboard without reporting anything, so the copy
command looks like it worked while Script Workspace pastes nothing. (Through 0.1.20 the Windows
side wrote text only, which is exactly what that looked like.)

One difference between the two: on Windows both flavours are published together, so the XML also
pastes into a text editor. On macOS AppleScript's `set the clipboard to` sets a *single* flavour,
so after `Cmd+Option+B` the clipboard holds FileMaker's format instead of text.

## Build, test, deploy

Plain JavaScript, zero runtime dependencies, no build step for the code. Node.js is the only
requirement (`vsce` is fetched on demand via `npx`).

```sh
npm test                 # round-trip stability check (text → XML → text → XML)
npm run sync-templates   # fold locally learned templates into the bundled starter set
npm run package          # build fm-bridge-<version>.vsix
npm run install-ide      # install the newest .vsix (Windows, PowerShell)
npm run install-ide:mac  # install the newest .vsix (macOS/Linux)
npm run deploy           # sync-templates + test + package + install-ide
npm run deploy:mac       # same, using the macOS installer
```

**Bump `version` in `package.json` before every package**, or your editor may keep serving a
cached build.

`npm test` runs `test/roundtrip.test.js` in plain Node with no VS Code dependency, asserting that
canonical text and XML are fixed points, that no errors occur, and that step counts are preserved.
To test another script: `node test/roundtrip.test.js path/to/file.fmscript`.

When adding or changing a step's XML shape, get a real copied instance from FileMaker as ground
truth. Guessed schemas have silently broken steps before — FileMaker's paste parser discards
children it does not recognise, leaving a step that looks fine but has empty parameters.

## Known limitations

- A step that is neither built-in nor learned cannot be *authored* from scratch — copy one
  instance from FileMaker first so its template is learned.
- Learned templates refill slots by parameter *label*, so a step whose meaning depends on child
  *order* with duplicate labels could rebuild incorrectly. None are known in practice.
- `Perform Find [ Restore ]` and saved sort orders cannot be reconstructed from text; they
  round-trip via passthrough only.
- FileMaker resolves pasted references by name: `Perform Script` / `Go to Layout` targets and
  field names must exist, and match case, in the target file. Verify after pasting.
- Whole-script copies paste back as *steps* into an open script, not as a new entry in the
  script list.
- On Linux, pasting back into FileMaker is not supported.

## License

[MIT](LICENSE) © 2026 KiBiz Systems.

Permission is granted to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the software, subject to including the copyright notice and permission notice. The
software is provided "as is", without warranty of any kind. See [LICENSE](LICENSE) for the full
text.

FileMaker and Claris are trademarks of Claris International Inc. FM Bridge is an independent
project and is not affiliated with or endorsed by Claris.
