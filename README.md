# FM Bridge — FileMaker Script ⇄ Text

**Write FileMaker scripts the way you write code: as text, in your editor, with AI at your
side. Then paste them straight back into FileMaker.**

FM Bridge is a VS Code extension that turns FileMaker Pro's script steps into readable
`.fmscript` text and back again. Copy steps out of Script Workspace, edit them by hand or with an
AI assistant, and paste the result into FileMaker. There's no retyping and no clicking through
step dialogs one option at a time.

No server, no account, no telemetry, no runtime dependencies. Everything runs locally.

**Works on Windows and macOS.** Both clipboard directions are verified against FileMaker Pro on
each platform.

## Why FM Bridge

- **AI-ready FileMaker.** Claude, Copilot, Cursor and other assistants can read and write
  FileMaker scripts as text, so you can ask for a script and paste it straight into FileMaker.
- **Real code tooling.** You get search and replace across a whole script, multi-cursor edits,
  version control, diffs and code review, none of which Script Workspace offers.
- **Trained on FileMaker Pro 2025.** 216 script steps work out of the box, all captured from
  real FileMaker copies. FM Bridge also learns new steps from a single copy (see
  [Training](#train-it-on-your-scripts)).
- **Nothing is ever lost.** Any step it can't model as text still round-trips byte-for-byte.

## Built for KiBuild: about 50% less development time

FM Bridge is the clipboard half of the AI toolkit we use every day at KiBiz Systems.
[**KiBuild**](https://github.com/KiBiz-Systems/kibuild-mcp) is our MCP server that gives AI
coding tools structured access to a FileMaker solution's scripts, layouts, tables and
relationships, plus validation for generated script XML. Together they close the loop:

1. **KiBuild** lets the AI understand your solution: where a field is used, what a script calls,
   how tables relate.
2. **The AI writes or changes scripts** as `.fmscript` text, grounded in your real schema.
3. **FM Bridge** puts that text back into FileMaker with one shortcut.

On KiBiz Systems' own FileMaker projects, pairing FM Bridge with KiBuild has **cut development
time by around 50%**. [Get KiBuild →](https://github.com/KiBiz-Systems/kibuild-mcp)

## Install

Download the build for your platform:

| Platform | Download |
| --- | --- |
| macOS | [**fm-bridge-mac.vsix**](https://github.com/KiBiz-Systems/FMBridge/releases/latest/download/fm-bridge-mac.vsix) |
| Windows | [**fm-bridge-windows.vsix**](https://github.com/KiBiz-Systems/FMBridge/releases/latest/download/fm-bridge-windows.vsix) |

Then install it with your editor's CLI (shown for macOS — use `fm-bridge-windows.vsix` on Windows):

```sh
curl -LO https://github.com/KiBiz-Systems/FMBridge/releases/latest/download/fm-bridge-mac.vsix

# VS Code
code --install-extension fm-bridge-mac.vsix

# Antigravity IDE
antigravity-ide --install-extension fm-bridge-mac.vsix

# Cursor / VSCodium / Windsurf and other forks
cursor --install-extension fm-bridge-mac.vsix
```

Or from the editor UI: **Extensions** view → `…` menu → **Install from VSIX…**

Those download links always serve the current release. Earlier builds, and what changed in each,
are on the [releases page](https://github.com/KiBiz-Systems/FMBridge/releases).

Then run **Developer: Reload Window**. This step is required — installing a `.vsix` does not
hot-swap an extension that is already running.

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

## Train it on your scripts

The bundled coverage was trained on **FileMaker Pro 2025** scripts. Your own solution may use
steps or options that set doesn't include. Training it takes about five minutes:

1. Build a throwaway script in FileMaker containing every step you use, **with their options
   configured**. FileMaker leaves unset options out of its XML, so configured steps teach more.
2. Copy it and paste it into any `.fmscript` file with `Ctrl+Alt+V` / `Cmd+Option+V`.
3. Every step FM Bridge could model can now be written from scratch as text.

What it learns lives in `.fmbridge/templates.json`. Commit that file to share it with your team,
or contribute it back so it ships to everyone.

**[Read the full training guide →](TRAINING.md)**

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

## What's next

These are ideas we're exploring. None of them is in FM Bridge yet. If one would make a
difference to your team, [tell us](#connect-with-kibiz-systems): demand decides what comes
first.

- **Schema-aware autocomplete.** Complete table, field, layout and script names from your actual
  solution via KiBuild, instead of only names already used in your `.fmscript` files.
- **Live error checking.** Red squiggles as you type for unknown steps, missing parameters,
  unbalanced `If` / `End If` and `Loop` / `End Loop`, and field or script references that don't
  exist in the target file.
- **Paste a whole script, not just steps.** Create a new entry in FileMaker's script list
  straight from a `.fmscript` file, including folders and script settings.
- **Beyond scripts.** Two-way conversion for custom functions, tables, fields and value lists,
  which FileMaker also exchanges through its clipboard.
- **Editable find and sort criteria.** Turn `Perform Find [ Restore ]` and saved sort orders
  into readable, editable text instead of raw XML.
- **Hover documentation.** Signatures and descriptions for every script step and calculation
  function, right where you type.
- **Calculation formatter.** One keystroke to tidy indentation in long `Let`, `Case` and
  `While` expressions.
- **Shared team training.** A central, organisation-wide template store so a step learned by
  one developer is instantly available to everyone.
- **Marketplace install.** Publishing to the VS Code Marketplace and Open VSX for one-click
  install and automatic updates.

## Connect with KiBiz Systems

FM Bridge is built and used in production by **KiBiz Systems**, FileMaker developers who build
AI-assisted workflows for their own client work.

**Want to get more out of it?** Whether you're rolling FM Bridge and KiBuild out across a team,
training it on a large solution, or wondering whether AI-assisted FileMaker development fits
your projects, we'd like to hear from you.

- 💬 **Leave a message:** start a thread in
  [KiBuild Discussions](https://github.com/KiBiz-Systems/kibuild-mcp/discussions)
- 🌐 **Talk to us:** [contact KiBiz Systems](https://www.kibizsystems.com/contact-kibiz/)
- 🧰 **Try the full toolkit:** [KiBuild MCP](https://github.com/KiBiz-Systems/kibuild-mcp)

## License

**Source-Available License — Commercial Development Permitted; Tool Resale Restricted.**
© 2026 KiBiz Systems.

**FM Bridge is free to download and use**, including for paid work.

| ✅ You can | ❌ You can't (without written permission) |
|---|---|
| Use it for personal and commercial work | Sell, sublicense or rebrand FM Bridge itself |
| Build, test, maintain and sell FileMaker solutions with it | Redistribute it commercially, including modified versions |
| Charge for development services you deliver with it | Bundle it into a commercial toolkit, plugin package or other product |
| Keep full ownership of the scripts and solutions you create | Ship FM Bridge or its components inside the solutions you sell |

Need a use the license doesn't cover, such as bundling or reselling? Ask us first:
[connect with KiBiz Systems](#connect-with-kibiz-systems). This summary is for convenience;
[LICENSE](LICENSE) has the binding terms.

FileMaker and Claris are trademarks of Claris International Inc. FM Bridge is an independent
project and is not affiliated with or endorsed by Claris.
