'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { xmlToText, textToXml, KEYS } = require('./lib/steps');
const versions = require('./lib/versions');

// --- FileMaker version (setting fmBridge.fileMakerVersion) -------------------

function fmVersion() {
  const v = String(vscode.workspace.getConfiguration('fmBridge').get('fileMakerVersion', versions.DEFAULT_VERSION));
  return versions.VERSIONS.includes(v) ? v : versions.DEFAULT_VERSION;
}

// --- template store (workspace .fmbridge/templates.json) --------------------

// Learned templates are not version-scoped: the clipboard doesn't say which
// FileMaker a paste came from. Only the bundled data (lib/versions) is.
function storePath() {
  const ws = vscode.workspace.workspaceFolders;
  if (!ws || !ws.length) return null;
  return path.join(ws[0].uri.fsPath, '.fmbridge', 'templates.json');
}

function loadStore() {
  const name = fmVersion();
  const p = storePath();
  // Bundled starter templates, built-ins and display labels for this version
  // (captured from real FileMaker pastes); workspace-learned templates override them.
  const fm = versions.loadVersion(name);
  const store = {
    version: name,
    templates: Object.assign({}, fm.templates),
    builtins: fm.builtins,
    paramAliases: fm.paramAliases,
    unavailable: versions.unavailableSteps(name),
    dirty: false,
  };
  if (p && fs.existsSync(p)) {
    try {
      Object.assign(store.templates, JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (e) {
      vscode.window.showWarningMessage('FM Bridge: could not read templates.json (' + e.message + ')');
    }
  }
  return store;
}

function saveStore(store) {
  if (!store.dirty) return;
  const p = storePath();
  if (!p) return;
  // Persist only what differs from the bundled starter set, so workspace
  // templates.json stays a diff, not a copy of everything shipped.
  const starter = versions.loadVersion(store.version).templates;
  const own = {};
  for (const name of Object.keys(store.templates)) {
    if (JSON.stringify(store.templates[name]) !== JSON.stringify(starter[name])) {
      own[name] = store.templates[name];
    }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(own, null, 2));
  store.dirty = false;
}

// --- clipboard ----------------------------------------------------------------

function extractSnippet(text) {
  const start = text.indexOf('<fmxmlsnippet');
  if (start === -1) return null;
  const endTag = '</fmxmlsnippet>';
  const end = text.indexOf(endTag, start);
  if (end === -1) return null;
  return text.slice(start, end + endTag.length);
}

// Windows: read FileMaker's private clipboard formats (Mac-XMSS etc.) via PowerShell.
function readFmClipboardWindows(context) {
  const ps1 = path.join(context.extensionPath, 'read-fm-clipboard.ps1');
  const out = cp.execFileSync('powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return extractSnippet(out || '');
}

// macOS: the same private formats live on the pasteboard under four-char codes
// (the Mac- prefix is Windows-only) — XMSS for script steps, XMSC scripts, etc.
// osascript coerces the clipboard to that raw type and prints «data XMSS<hex>»;
// hex-decode to the UTF-8 XML (may carry a 4-byte length header, which
// extractSnippet skips by locating the <fmxmlsnippet substring).
const MAC_CLIP_TYPES = ['XMSS', 'XMSC', 'XMTB', 'XMFD', 'XMFN', 'XMVL', 'XML2'];
const GL = '«'; // «
const GR = '»'; // »
function readFmClipboardMac() {
  for (const t of MAC_CLIP_TYPES) {
    let out;
    try {
      out = cp.execFileSync('osascript', ['-e', 'the clipboard as ' + GL + 'class ' + t + GR],
        { encoding: 'utf8', timeout: 10000 });
    } catch (e) {
      continue; // this type isn't on the clipboard
    }
    const m = new RegExp(GL + 'data ' + t + '([0-9A-Fa-f]*)' + GR).exec(out || '');
    if (!m || !m[1]) continue;
    const snippet = extractSnippet(Buffer.from(m[1], 'hex').toString('utf8'));
    if (snippet) return snippet;
  }
  return null;
}

// macOS write path. FileMaker's Script Workspace on macOS pastes ONLY from its
// private pasteboard type — a plain-text <fmxmlsnippet> clipboard is silently
// ignored, which is why Cmd+Alt+B appeared to do nothing while the same text
// clipboard works on Windows FM. Mirror of readFmClipboardMac: an AppleScript
// raw-data literal «data XMSS<hex>». textToXml only ever emits top-level <Step>
// objects (whole-script copies paste back as steps), so XMSS is always the right
// class here. Sent on stdin, not -e: hex doubles the payload and a large script
// would blow past the argv size limit.
function writeFmClipboardMac(xml) {
  const hex = Buffer.from(xml, 'utf8').toString('hex').toUpperCase();
  cp.execFileSync('osascript', ['-'], {
    input: 'set the clipboard to ' + GL + 'data XMSS' + hex + GR,
    encoding: 'utf8',
    timeout: 15000,
  });
}

// Windows write path — the mirror of readFmClipboardWindows, and the same
// lesson macOS taught: FileMaker resolves a paste from its own registered
// clipboard format ("Mac-XMSS", the Mac- prefix is what FM registers on Windows
// too) and silently ignores a clipboard that carries only text, so Ctrl+Alt+B
// reported success while Script Workspace pasted nothing. The PowerShell helper
// publishes the private format AND the text flavour from one DataObject, so
// unlike macOS the plain-text clipboard survives here.
function writeFmClipboardWindows(context, xml) {
  const ps1 = path.join(context.extensionPath, 'write-fm-clipboard.ps1');
  cp.execFileSync('powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Format', 'Mac-XMSS'],
    { input: Buffer.from(xml, 'utf8'), timeout: 15000, windowsHide: true });
}

// Diagnostic command only — dumps whatever is currently on the Windows
// clipboard (real FileMaker copy or our own Ctrl+Alt+B write) so the two can
// be compared byte-for-byte to root-cause a paste that silently does nothing.
let debugChannel;
function dumpClipboardDebug(context) {
  if (process.platform !== 'win32') {
    vscode.window.showInformationMessage('FM Bridge: clipboard dump is Windows-only.');
    return;
  }
  const ps1 = path.join(context.extensionPath, 'dump-clipboard.ps1');
  let out;
  try {
    out = cp.execFileSync('powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { timeout: 15000, windowsHide: true }).toString('utf8');
  } catch (e) {
    out = 'FAILED: ' + e.message + '\n' + (e.stdout || '') + (e.stderr || '');
  }
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel('FM Bridge Debug');
  debugChannel.clear();
  debugChannel.appendLine(out);
  debugChannel.show(true);
}

async function readFileMakerClipboard(context) {
  const text = await vscode.env.clipboard.readText();
  const snippet = extractSnippet(text || '');
  if (snippet) return snippet;
  // Not on the plain-text clipboard: read FileMaker's private formats per OS.
  try {
    if (process.platform === 'win32') return readFmClipboardWindows(context);
    if (process.platform === 'darwin') return readFmClipboardMac();
  } catch (e) { /* fall through to null */ }
  return null;
}

// --- commands -------------------------------------------------------------------

async function pasteFromFileMaker(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const xml = await readFileMakerClipboard(context);
  if (!xml) {
    // Not FileMaker content: behave like a normal paste so the shortcut is always safe.
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    return;
  }
  const store = loadStore();
  const { text, warnings } = xmlToText(xml, store);
  saveStore(store);
  await editor.edit((edit) => {
    for (const sel of editor.selections) {
      if (sel.isEmpty) edit.insert(sel.active, text);
      else edit.replace(sel, text);
    }
  });
  const stepCount = (text.match(/\n/g) || []).length;
  if (warnings.length) {
    vscode.window.showWarningMessage('FM Bridge: pasted ' + stepCount + ' lines. ' + warnings[0] +
      (warnings.length > 1 ? ' (+' + (warnings.length - 1) + ' more)' : ''));
  } else {
    vscode.window.setStatusBarMessage('FM Bridge: pasted ' + stepCount + ' script lines from FileMaker', 4000);
  }
}

async function copyAsFileMakerXml(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const sel = editor.selection;
  const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
  const store = loadStore();
  const { xml, errors, stepCount } = textToXml(text, store);
  if (errors.length) {
    vscode.window.showErrorMessage('FM Bridge: ' + errors.length + ' error(s). First: ' + errors[0]);
    return;
  }
  // Text first, so a failed native write still leaves the XML on the clipboard
  // rather than nothing. On macOS the native write then replaces it (AppleScript's
  // `set the clipboard to` sets a single flavor) because that is the only flavor
  // FileMaker will paste from there.
  await vscode.env.clipboard.writeText(xml);
  let warning = '';
  if (process.platform === 'darwin') {
    try {
      writeFmClipboardMac(xml);
    } catch (e) {
      warning = ' (warning: could not set FileMaker\'s pasteboard type - ' +
        'the XML is on the clipboard as text, which FileMaker for macOS will not paste)';
    }
  } else if (process.platform === 'win32') {
    try {
      writeFmClipboardWindows(context, xml);
    } catch (e) {
      warning = ' (warning: could not set FileMaker\'s clipboard format - ' +
        'the XML is on the clipboard as text, which FileMaker for Windows will not paste)';
    }
  }
  const msg = 'FM Bridge: ' + stepCount + ' steps copied as ' + versions.label(store.version) + ' XML - ' +
    'switch to Script Workspace and paste (' + KEYS.fmPaste + ').' + warning;
  if (warning) vscode.window.showWarningMessage(msg);
  else vscode.window.showInformationMessage(msg);
}

// --- autocomplete ------------------------------------------------------------------

function buildCompletionProvider() {
  return {
    async provideCompletionItems(document, position) {
      const items = [];
      const line = document.lineAt(position).text;
      const before = line.slice(0, position.character);
      const atLineStart = /^\s*(\/\/\s*)?[\w/ -]*$/.test(before);
      const store = loadStore();
      const fm = versions.loadVersion(store.version);

      if (atLineStart) {
        const templateNames = Object.keys(store.templates || {});
        const builtinNames = Object.keys(store.builtins);
        const seen = new Set();
        for (const name of [...builtinNames, ...templateNames, ...fm.extraStepNames]) {
          if (seen.has(name)) continue;
          seen.add(name);
          const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword);
          item.sortText = '0' + name;
          if (templateNames.includes(name) && !builtinNames.includes(name)) {
            const spec = store.templates[name].paramSpec || [];
            item.detail = 'learned template';
            item.insertText = spec.length
              ? new vscode.SnippetString(name + ' [ ' + spec.map((p, i) => p.label + ': ${' + (i + 1) + '}').join(' ; ') + ' ]')
              : name;
          } else {
            item.detail = builtinNames.includes(name) ? 'built-in step' : 'step (copy from FileMaker once to enable ' + KEYS.copy + ')';
            item.insertText = snippetForBuiltin(name);
          }
          items.push(item);
        }
      }

      // Calculation functions
      for (const sig of fm.functions) {
        const name = sig.split(' (')[0];
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        item.detail = sig;
        item.insertText = sig.includes('(') ? new vscode.SnippetString(name + ' ( ${1} )') : name;
        item.sortText = '2' + name;
        items.push(item);
      }
      for (const flag of fm.getFlags) {
        const expr = 'Get ( ' + flag + ' )';
        const item = new vscode.CompletionItem(expr, vscode.CompletionItemKind.Constant);
        item.filterText = 'Get' + flag + ' ' + expr;
        item.insertText = expr;
        item.sortText = '3' + flag;
        items.push(item);
      }

      // $ / $$ variables already used in this document
      const seenVars = new Set();
      const varRe = /\$\$?[A-Za-z_][\w.]*/g;
      let m;
      const docText = document.getText();
      while ((m = varRe.exec(docText))) seenVars.add(m[0]);
      for (const v of seenVars) {
        const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable);
        item.sortText = '1' + v;
        items.push(item);
      }

      // Script names: .fmscript files in the workspace
      try {
        const files = await vscode.workspace.findFiles('**/*.fmscript', '**/node_modules/**', 200);
        for (const f of files) {
          const name = path.basename(f.fsPath, '.fmscript');
          const item = new vscode.CompletionItem('"' + name + '"', vscode.CompletionItemKind.Reference);
          item.detail = 'script in workspace';
          item.filterText = name;
          item.sortText = '1"' + name;
          items.push(item);
        }
      } catch (e) { /* no workspace */ }

      return items;
    },
  };
}

function snippetForBuiltin(name) {
  switch (name) {
    case 'Set Variable': return new vscode.SnippetString('Set Variable [ \\$${1:var} ; Value: ${2} ]');
    case 'Set Field': return new vscode.SnippetString('Set Field [ ${1:Table}::${2:Field} ; ${3} ]');
    case 'If': return new vscode.SnippetString('If [ ${1} ]\n    ${2}\nEnd If');
    case 'Else If': return new vscode.SnippetString('Else If [ ${1} ]');
    case 'Loop': return new vscode.SnippetString('Loop\n    Exit Loop If [ ${1} ]\n    ${2}\nEnd Loop');
    case 'Exit Loop If': return new vscode.SnippetString('Exit Loop If [ ${1} ]');
    case 'Exit Script': return new vscode.SnippetString('Exit Script [ Text Result: ${1} ]');
    case 'Perform Script': return new vscode.SnippetString('Perform Script [ "${1}" ; Parameter: ${2} ]');
    case 'Show Custom Dialog': return new vscode.SnippetString('Show Custom Dialog [ Title: "${1}" ; Message: "${2}" ; Buttons: "${3:OK}" ]');
    case 'Go to Record/Request/Page': return new vscode.SnippetString('Go to Record/Request/Page [ ${1|First,Last,Next,Previous|} ]');
    case 'Pause/Resume Script': return new vscode.SnippetString('Pause/Resume Script [ Duration (seconds): ${1:0.5} ]');
    case 'Enter Find Mode': return new vscode.SnippetString('Enter Find Mode [ Pause: ${1|Off,On|} ]');
    case 'Set Error Capture': return new vscode.SnippetString('Set Error Capture [ ${1|On,Off|} ]');
    case 'Comment': return new vscode.SnippetString('# ${1}');
    default: return name;
  }
}

// --- inline folding of sealed data (#blob and #fmxml payloads) ---------------
// The data must stay in the file (it IS the step's embedded settings), but the
// editor collapses it to a small badge. Putting the cursor on the line reveals
// the full content. Uses the font-size CSS injection technique (same as the
// popular "Inline Fold" extension) since VS Code has no inline-collapse API.

const sealedFold = vscode.window.createTextEditorDecorationType({
  textDecoration: 'none; font-size: 0.001em',
});

function humanSize(chars) {
  return chars < 1024 ? chars + ' B' : (chars / 1024).toFixed(1) + ' KB';
}

function updateSealedFolds(editor) {
  if (!editor || editor.document.languageId !== 'fmscript') return;
  const cursorLines = new Set(editor.selections.map((s) => s.active.line));
  const decos = [];
  for (let i = 0; i < editor.document.lineCount; i++) {
    if (cursorLines.has(i)) continue; // reveal while the cursor is on the line
    const text = editor.document.lineAt(i).text;
    // "Label: #blob <base64>" — hide the base64, keep "#blob" as the marker
    const blobRe = /#blob\s+([A-Za-z0-9+/=]{24,})/g;
    let m;
    while ((m = blobRe.exec(text))) {
      decos.push({
        range: new vscode.Range(i, m.index + '#blob'.length, i, m.index + m[0].length),
        renderOptions: { after: { contentText: ' ⟨' + humanSize(m[1].length) + ' sealed⟩', color: new vscode.ThemeColor('descriptionForeground') } },
      });
    }
    // "#fmxml <xml>" / "#fmxml64 Name <base64>" — hide the payload, keep the step name
    const fm = /^(\s*(?:\/\/\s*)?#fmxml(?:64)?\s)(.{60,})$/.exec(text);
    if (fm) {
      const name = /name="([^"]*)"/.exec(fm[2]) || /^(\S+)/.exec(fm[2]);
      decos.push({
        range: new vscode.Range(i, fm[1].length, i, text.length),
        renderOptions: { after: { contentText: '⟨' + (name ? name[1] + ', ' : '') + humanSize(fm[2].length) + ' raw XML⟩', color: new vscode.ThemeColor('descriptionForeground') } },
      });
    }
  }
  editor.setDecorations(sealedFold, decos);
}

// --- FileMaker version picker (status bar) ----------------------------------------

const versionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
versionItem.command = 'fmBridge.selectFileMakerVersion';
versionItem.tooltip = 'FileMaker version FM Bridge targets - click to change';

function updateVersionItem(editor) {
  versionItem.text = 'FM ' + fmVersion();
  if (editor && editor.document.languageId === 'fmscript') versionItem.show();
  else versionItem.hide();
}

async function selectFileMakerVersion() {
  const current = fmVersion();
  const picked = await vscode.window.showQuickPick(versions.VERSIONS.map((name) => {
    const v = versions.loadVersion(name);
    return {
      label: versions.label(name),
      description: [name === current ? 'current' : null,
        v.minor != null ? 'captured from ' + v.major + '.' + v.minor : null].filter(Boolean).join(' - '),
      name,
    };
  }), { placeHolder: 'FileMaker version this workspace targets' });
  if (!picked || picked.name === current) return;
  const target = vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('fmBridge').update('fileMakerVersion', picked.name, target);
}

// --- activation --------------------------------------------------------------------

function activate(context) {
  context.subscriptions.push(
    versionItem,
    vscode.commands.registerCommand('fmBridge.pasteFromFileMaker', () => pasteFromFileMaker(context)),
    vscode.commands.registerCommand('fmBridge.copyAsFileMakerXml', () => copyAsFileMakerXml(context)),
    vscode.commands.registerCommand('fmBridge.dumpClipboardDebug', () => dumpClipboardDebug(context)),
    vscode.commands.registerCommand('fmBridge.selectFileMakerVersion', selectFileMakerVersion),
    vscode.languages.registerCompletionItemProvider({ language: 'fmscript' }, buildCompletionProvider()),
    vscode.window.onDidChangeActiveTextEditor(updateVersionItem),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fmBridge.fileMakerVersion')) updateVersionItem(vscode.window.activeTextEditor);
    }),
    vscode.window.onDidChangeActiveTextEditor(updateSealedFolds),
    vscode.window.onDidChangeTextEditorSelection((e) => updateSealedFolds(e.textEditor)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === e.document) updateSealedFolds(ed);
    })
  );
  vscode.window.visibleTextEditors.forEach(updateSealedFolds);
  updateVersionItem(vscode.window.activeTextEditor);
}

function deactivate() {}

module.exports = { activate, deactivate };
