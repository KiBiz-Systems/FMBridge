# Training FM Bridge on your FileMaker scripts

FM Bridge gets better at your scripts the more of them it sees, and you don't have to wait for
us to teach it. This guide shows how to train it on the steps your team uses, keep it current
when Claris ships a new FileMaker version, and feed what you learn back so everyone benefits.

**No AI model, no cloud upload.** "Training" here means FM Bridge records the exact XML shape of
each script step you copy out of FileMaker, so it can rebuild that step from plain text later.
Everything stays on your machine, in your workspace.

**Contents**

1. [What ships out of the box](#what-ships-out-of-the-box)
2. [How training works](#how-training-works)
3. [Train it in five minutes](#train-it-in-five-minutes)
4. [Verify a newly trained step](#verify-a-newly-trained-step)
5. [When to retrain](#when-to-retrain)
6. [Training for a new FileMaker version](#training-for-a-new-filemaker-version)
7. [Share training with your team](#share-training-with-your-team)
8. [Improve FM Bridge yourself](#improve-fm-bridge-yourself)

---

## What ships out of the box

FM Bridge comes trained on real **FileMaker Pro 2025 (v22)** scripts. Every bundled template was
captured from an actual FileMaker copy, not written by hand.

| | Steps | What it means |
|---|---|---|
| Built-in formatters | 26 | Hand-verified control-flow and data steps (`Set Variable`, `If`, `Loop`, `Perform Script` …) |
| Pre-trained templates | 192 | Captured from FileMaker 2025 and bundled in `lib/versions/base/templates.json` |
| **Ready to write from scratch** | **216** | No training needed |

Anything else still round-trips safely as a raw `#fmxml` line. You just can't edit it as text
until FM Bridge has learned it.

## How training works

Every time you press `Ctrl+Alt+V` / `Cmd+Option+V` to paste steps **from** FileMaker, FM Bridge
also learns from them:

1. It reads each step's XML and works out which parts are parameters (calculations, On/Off
   options, field references, nested settings) and which parts are fixed.
2. It saves that shape as a **template** in `.fmbridge/templates.json` in your workspace.
3. From then on you can type that step as text, e.g.
   `Insert from URL [ Target: $result ; URL: "https://…" ; With dialog: Off ]`, and
   `Ctrl+Alt+B` / `Cmd+Option+B` rebuilds valid FileMaker XML for it.

Your workspace templates override the bundled ones. A newer copy replaces the stored template
when it teaches something new, with one safeguard: **a copy with fewer options never overwrites a
richer template.** So copying an unconfigured step can't erase what FM Bridge already knows.

## Train it in five minutes

1. **In FileMaker, create a throwaway "training" script.** Add one of every step your team uses,
   paying particular attention to anything outside the 216 already covered.
2. **Configure every option you care about.** This is the most important step. FileMaker leaves
   unset options out of its XML, so a freshly dragged-in step with nothing specified teaches a
   template with no slot for those options. Fill in the target field, tick the checkboxes, set
   the dialog options, enter a URL.
3. **Select all the steps and copy** (`Ctrl+C` / `Cmd+C`).
4. **In your editor, open any `.fmscript` file and press `Ctrl+Alt+V` / `Cmd+Option+V`.** The
   steps appear as text, and FM Bridge has now learned every one it could model.
5. **Check the result.** Any step still shown as `#fmxml …` is too complex to model as text. It
   will still paste back perfectly, but it isn't editable.

## Verify a newly trained step

Before relying on a step in real work, prove the round trip once:

1. Write the step from scratch in a `.fmscript` file, with its parameters filled in.
2. Select it and press `Ctrl+Alt+B` / `Cmd+Option+B`.
3. Paste into Script Workspace and open the step's options. Every parameter should be set.

If a parameter comes through empty, re-train from a copy where that option is configured.

## When to retrain

FM Bridge tells you when it needs another example:

| Message | What to do |
|---|---|
| `unrecognized step "…" - no built-in or learned template` | The step has never been learned. Copy one configured instance from FileMaker and paste it with `Ctrl+Alt+V`. If it says *did you mean "…"*, it's a typo instead. |
| `unknown parameter "…" - not in this step's learned template` | The template was learned from a copy without that option. Copy a step where the option **is** set, and paste it. |
| `… expects a "#blob …" value` | The option holds binary settings (print setup, import map) that can only come from FileMaker. Copy the configured step from FileMaker. |
| `"…" kept as raw XML (complex step)` | Not an error: the step will paste back unchanged, it just can't be edited as text. |

---

## Training for a new FileMaker version

FM Bridge isn't tied to FileMaker 2025. It reads whatever XML your FileMaker produces, so when
Claris adds steps (as FileMaker 2025 did with AI and RAG steps such as `Configure AI Account` and
`Perform Semantic Find`), you can teach them yourself on the day you upgrade. You don't need to
wait for an FM Bridge release.

Use this checklist each time you move to a new FileMaker version.

### 1. Find out what changed

- Read the **"New and changed script steps"** section of Claris's release notes for the version.
  Note both brand-new steps and existing steps that gained options.
- Open Script Workspace and scan each step category for names you don't recognise.
- In a `.fmscript` file, start typing a step name. If autocomplete doesn't offer it, FM Bridge
  has never heard of it.

### 2. Build a training script per category

One large script is fine, but a script per category (*AI*, *Records*, *Windows* …) is easier
to re-copy later when a single area changes. For every new or changed step:

- **Configure every option that can be set together**, as described in
  [Train it in five minutes](#train-it-in-five-minutes).
- **For steps with alternative modes** (options that rule each other out, so no single instance
  can have them all set), add one instance per mode. FM Bridge keeps one template per step, and
  the most recent copy that teaches a new option wins. **Paste the mode your team uses most
  last**, or copy it again afterwards.

### 3. Copy, paste and read the warnings

Copy the training script and paste it into an empty `.fmscript` file with `Ctrl+Alt+V` /
`Cmd+Option+V`. Then sort the results:

| You see | Meaning |
|---|---|
| A normal step line, e.g. `Configure AI Account [ … ]` | Learned. Go to step 4 and verify it. |
| `#fmxml …` or `#fmxml64 …` | Too complex to model as text. It will round-trip safely; report it (see [Improve FM Bridge yourself](#improve-fm-bridge-yourself)) if you need to edit it as text. |
| A line with `#blob` | Learned, but part of it is opaque binary data from FileMaker. Fine to use; don't hand-edit the base64. |

### 4. Verify each new step in FileMaker

For each learned step, run the [verification round trip](#verify-a-newly-trained-step). For
new steps it's worth going one step further: write the step **from scratch** with every
parameter, paste it into FileMaker, and compare its options dialog side by side with the
original. FileMaker silently drops XML it doesn't understand, so a step can look right in the
script and still have empty options.

If you have [KiBuild](https://github.com/KiBiz-Systems/kibuild-mcp) installed, ask your AI
assistant to run its `validate_fmxmlsnippet` tool on the generated XML as an extra check before
pasting.

### 5. Keep your training script

Save the training script in your FileMaker file (or as a `.fmscript` alongside your project). At
the next version upgrade you only need to add the new steps and re-copy it.

---

## Share training with your team

`.fmbridge/templates.json` is a plain JSON file holding only what your workspace learned beyond
the bundled set. To give everyone on a project the same coverage, **commit it to that project's
repository.** Each teammate who opens the workspace picks it up automatically.

Before sharing, check that the file doesn't carry anything client-specific. Templates store a
step's *shape*, not your data, but fixed parts of a step can include layout, script or field
names from the file it was copied from.

---

## Improve FM Bridge yourself

Training covers most needs, but the extension itself is plain JavaScript with no build step, and
these improvements are well within reach. Each one makes FM Bridge better for every FileMaker
developer who uses it.

### Contribute templates to the bundled set

The highest-value contribution: steps you've trained, especially those from a **newer
FileMaker version** than the one the bundled set was captured from.

```sh
# in a clone of this repository
cp /path/to/your-project/.fmbridge/templates.json .fmbridge/templates.json
npm run sync-templates   # asks which FileMaker the steps came from, then merges into
                         # lib/versions/<version>/templates.json, never losing richer templates
npm test                 # round-trip check must stay green
```

Then open a pull request. **State the FileMaker version and platform you captured from** in the
description. `sync-templates` applies the same "richer template wins" rule and logs every template
it kept, so a lean capture can't downgrade a shipped one.

### Other improvements, by difficulty

| Improvement | Where | Effort |
|---|---|---|
| **Add new step names to autocomplete.** Steps from a new FileMaker version that aren't learned yet. | `EXTRA_STEP_NAMES` in `lib/versions/<version>/fmdata.js` | A few minutes |
| **Add new calculation functions and `Get ( )` flags.** Claris adds some in most releases. | `FUNCTIONS` and `GET_FLAGS` in `lib/versions/<version>/fmdata.js` | A few minutes |
| **Teach FileMaker's display labels.** When Script Workspace shows a label that differs from the XML tag (it shows `With dialog: Off` where the XML says `NoInteract`), map it so people can type what they see. | `PARAM_ALIASES` in `lib/versions/base/builtins.js` | Under an hour |
| **Promote a heavily used step to a built-in.** It gets a cleaner text form and is verified by hand. | `BUILTINS` in `lib/versions/base/builtins.js` | Half a day, with testing |
| **Turn a passthrough step into editable text.** For a step that currently falls back to `#fmxml`. | `lib/steps.js` | Varies |

Ground rules for code changes:

- **Use a real FileMaker copy as ground truth.** Never guess an XML shape. Guessed schemas have
  broken steps before, because FileMaker silently drops children it doesn't recognise.
- **`npm test` must stay green**, and a real paste into Script Workspace is the final test.
- **Let an AI assistant help.** This repository's `CLAUDE.md` documents the architecture and the
  FileMaker quirks, so Claude Code, Cursor and similar tools can do much of this work with you.

### Report what you can't fix

If a step won't learn, or rebuilds wrongly, start a thread in
[KiBuild Discussions](https://github.com/KiBiz-Systems/kibuild-mcp/discussions) with:

- the FileMaker version and platform
- the step's text line and, if you can, its copied XML (remove client data first)
- what FileMaker showed after pasting

### Contribution terms

By opening a pull request, you agree that KiBiz Systems may include your contribution in FM
Bridge and distribute it under the FM Bridge [LICENSE](LICENSE).

---

Want help training FM Bridge on a large or unusual codebase, or rolling it out to a team?
[Contact KiBiz Systems](https://www.kibizsystems.com/contact-kibiz/), or see
[Connect with KiBiz Systems](README.md#connect-with-kibiz-systems).
