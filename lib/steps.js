'use strict';

const U = require('./xmlutil');
const zlib = require('zlib');

// User-facing shortcut hints. macOS binds Cmd where Windows/Linux bind Ctrl
// (see the "mac" variants in package.json's keybindings), and FileMaker itself
// pastes with Cmd+V on macOS. Error messages quote these, so they have to match
// what the user's keyboard actually does — defined here because both this module
// and extension.js need them.
const KEYS = (process.platform === 'darwin')
  ? { paste: 'Cmd+Alt+V', copy: 'Cmd+Alt+B', fmPaste: 'Cmd+V' }
  : { paste: 'Ctrl+Alt+V', copy: 'Ctrl+Alt+B', fmPaste: 'Ctrl+V' };

// ---------------------------------------------------------------------------
// FM Bridge converter core.
//
// Two directions, one contract:
//   xmlToText(xml, store)  -> { text, warnings }   FileMaker clipboard XML -> .fmscript text
//   textToXml(text, store) -> { xml, warnings, errors, stepCount }
//
// Coverage strategy:
//   1. BUILTINS — steps whose XML shape was verified by real pastes into the
//      user's file. Bijective: text form regenerates equivalent XML.
//   2. LEARNED  — any other step whose children are all "slottable"
//      (calculations, plain-text tags, state flags, typed values, field refs).
//      The real XML skeleton is cached in the template store on the way out of
//      FileMaker and refilled on the way back in.
//   3. PASSTHROUGH — anything else round-trips as a raw-XML line:
//      "#fmxml <Step .../>"  (single-line)  or  "#fmxml64 Name b64..." when the
//      step XML contains newlines. Lossless by construction.
// ---------------------------------------------------------------------------

const INDENT = '    ';
const INDENT_AFTER = new Set(['If', 'Else', 'Else If', 'Loop']);
const DEDENT_BEFORE = new Set(['Else', 'Else If', 'End If', 'End Loop']);

// --- small helpers ---------------------------------------------------------

function childByTag(els, tag) {
  return els.find((e) => e.tag === tag) || null;
}

function onOff(v) {
  return v === 'True' || v === true ? 'On' : 'Off';
}

function parseOnOff(s) {
  const v = String(s).trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return 'True';
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return 'False';
  return null;
}

// Split "a ; b ; c" at top level (not inside quotes/parens/brackets).
function splitTop(s, sep) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

function stripQuotes(s) {
  const t = s.trim();
  const pairs = [['"', '"'], ['“', '”']];
  for (const [a, b] of pairs) {
    if (t.startsWith(a) && t.endsWith(b) && t.length >= 2) return t.slice(a.length, t.length - b.length);
  }
  return t;
}

function labeled(args, label) {
  // find "Label: value" among parts (case-insensitive label)
  for (const part of args) {
    const m = /^([^:]+):\s*([\s\S]*)$/.exec(part);
    if (m && m[1].trim().toLowerCase() === label.toLowerCase()) return m[2].trim();
  }
  return null;
}

// Does this argument carry an explicit "Label: value" prefix? Anything that
// does NOT is eligible for positional placement (FileMaker's own display syntax
// leaves single-parameter steps unlabeled: "Allow User Abort [ Off ]"). The
// pattern deliberately matches only the emitted grammar — a label word followed
// by a colon AND whitespace — so a field reference ("Products::Name"), an
// unquoted URL ("https://x") or a calculation containing a colon are not
// mistaken for labels.
function looksLabeled(arg) {
  return /^[A-Za-z][A-Za-z0-9 ()_.-]*:(?!:)(\s|$)/.test(arg);
}

// Learned templates key their parameters on the XML tag name, because that is
// all the learner can see. FileMaker's Script Workspace DISPLAYS other words for
// the same things ("With dialog" for NoInteract, "Target" for the result field,
// "cURL options" for CURLOptions), and that display syntax is what people — and
// LLMs asked for a FileMaker script — actually write. Accept both spellings.
//
// `invert: true` marks a display label that is the logical negation of the
// stored flag: FM shows "With dialog: Off" where the XML holds NoInteract=True.
// An alias is ignored for any template that has a real slot of that name, so a
// genuine <Target> or <Options> child always wins over the alias.
const PARAM_ALIASES = {
  NoInteract: [{ label: 'With dialog', invert: true }, { label: 'With Dialog', invert: true }],
  Field: [{ label: 'Target' }],
  CURLOptions: [{ label: 'cURL options' }, { label: 'curl options' }],
  SelectAll: [{ label: 'Select entire contents' }, { label: 'Select' }],
  VerifySSLCertificates: [{ label: 'Verify SSL Certificates' }],
  DontEncodeURL: [{ label: 'Do not encode URL' }],
  Calculation: [{ label: 'URL' }],
};

function calcXml(wrapperTag, calc) {
  const inner = '<Calculation>' + U.cdata(calc) + '</Calculation>';
  return wrapperTag ? '<' + wrapperTag + '>' + inner + '</' + wrapperTag + '>' : inner;
}

// Consumed-children check: builtins only claim a step when nothing unexpected
// remains, otherwise we fall through to learned/passthrough so no data is lost.
// <Restore state="False"/> is treated as droppable noise (many client files
// stamp it on most steps); Restore state="True" is meaningful and NOT ignored.
function onlyTags(els, allowed) {
  return els.every((e) => e.tag === 'DisableStepCollapsed' ||
    (e.tag === 'Restore' && e.attrs.state === 'False') || allowed.includes(e.tag));
}

// --- built-in step handlers -------------------------------------------------
// ctx = { stash } for toText; toXml returns inner XML (without <Step> wrapper).

const BUILTINS = {
  'Set Variable': {
    toText(els, ctx) {
      if (!onlyTags(els, ['Name', 'Value', 'Repetition'])) return null;
      const name = childByTag(els, 'Name');
      const val = childByTag(els, 'Value');
      if (!name || !val) return null;
      const calc = U.calcText(val.inner, ctx.stash);
      if (calc == null) return null;
      let out = U.unmask(U.decodeEntities(name.inner), ctx.stash).trim() + ' ; Value: ' + calc;
      const rep = childByTag(els, 'Repetition');
      if (rep) {
        const rc = U.calcText(rep.inner, ctx.stash);
        if (rc != null && rc !== '1') out += ' ; Repetition: ' + rc;
      }
      return out;
    },
    toXml(argsStr) {
      const args = splitTop(argsStr, ';');
      if (!args[0] || !args[0].startsWith('$')) throw new Error('Set Variable needs "$name ; Value: calc"');
      const value = labeled(args, 'Value');
      if (value == null) throw new Error('Set Variable is missing "Value:"');
      let xml = '<Name>' + U.escapeXml(args[0]) + '</Name>' + calcXml('Value', value);
      const rep = labeled(args, 'Repetition');
      if (rep != null) xml += calcXml('Repetition', rep);
      return xml;
    },
  },

  'Set Field': {
    toText(els, ctx) {
      if (!onlyTags(els, ['Calculation', 'Field'])) return null;
      const field = childByTag(els, 'Field');
      if (!field) return null;
      const calc = U.calcText(els.map((e) => e.raw).join(''), ctx.stash);
      const ref = (field.attrs.table ? field.attrs.table + '::' : '') + (field.attrs.name || '');
      return calc != null ? ref + ' ; ' + calc : ref;
    },
    toXml(argsStr) {
      const args = splitTop(argsStr, ';');
      const ref = args[0] || '';
      const m = /^(?:([^:]+)::)?(.+)$/.exec(ref.trim());
      if (!m) throw new Error('Set Field needs "Table::Field ; calc"');
      const table = m[1] ? ' table="' + U.escapeXml(m[1].trim()) + '"' : '';
      let xml = '';
      if (args[1] != null && args[1] !== '') xml += calcXml(null, args.slice(1).join(' ; '));
      xml += '<Field' + table + ' name="' + U.escapeXml(m[2].trim()) + '"/>';
      return xml;
    },
  },

  'If': calcOnlyStep('If'),
  'Else If': calcOnlyStep('Else If'),
  'Exit Loop If': calcOnlyStep('Exit Loop If'),

  'Else': bareStep(),
  'End If': bareStep(),
  'Loop': {
    toText(els) {
      const kept = els.filter((e) => !isNoise(e));
      if (!kept.length) return '';
      if (kept.length === 1 && kept[0].tag === 'FlushType' && kept[0].attrs.value) {
        return 'Flush: ' + kept[0].attrs.value;
      }
      return null;
    },
    toXml(argsStr) {
      const args = dropRestoreLabel(splitTop(argsStr, ';'));
      if (!args.length) return '';
      const flush = labeled(args, 'Flush') || labeled(args, 'FlushType');
      if (flush != null && args.length === 1) return '<FlushType value="' + U.escapeXml(flush) + '"/>';
      throw new Error('Loop supports "Loop" or "Loop [ Flush: Always/Defer ]"');
    },
  },
  'End Loop': bareStep(),
  'Show All Records': bareStep(),
  'Halt Script': bareStep(),
  'Freeze Window': bareStep(),
  'New Record/Request': bareStep(),
  'Duplicate Record/Request': bareStep(),
  'Omit Record': bareStep(),
  'Open Record/Request': bareStep(),

  'Exit Script': {
    toText(els, ctx) {
      if (!onlyTags(els, ['Calculation'])) return null;
      const calc = U.calcText(els.map((e) => e.raw).join(''), ctx.stash);
      return 'Text Result: ' + (calc == null ? '' : calc);
    },
    toXml(argsStr) {
      const val = labeled(splitTop(argsStr, ';'), 'Text Result');
      if (val == null || val === '') return '';
      return calcXml(null, val);
    },
  },

  'Show Custom Dialog': {
    // Modern FM exports <Title>/<Message>/<Buttons> (all calc-wrapped; Buttons may
    // hold several <Calculation> children). The old <Text>/<Button1..3> shape is
    // read for compatibility but never emitted — FM's paste parser drops it.
    toText(els, ctx) {
      if (!onlyTags(els, ['Title', 'Text', 'Message', 'Buttons', 'Button1', 'Button2', 'Button3'])) return null;
      const parts = [];
      const title = childByTag(els, 'Title');
      if (title) {
        const c = U.calcText(title.inner, ctx.stash);
        if (c == null) return null;
        parts.push('Title: ' + c);
      }
      const msg = childByTag(els, 'Message') || childByTag(els, 'Text');
      if (msg) {
        const c = U.calcText(msg.inner, ctx.stash);
        if (c == null) return null;
        parts.push('Message: ' + c);
      }
      const btns = [];
      const commits = [];
      const buttonsEl = childByTag(els, 'Buttons');
      if (buttonsEl) {
        for (const k of U.topLevelElements(buttonsEl.inner)) {
          if (k.tag === 'Calculation') {
            // old export shape: bare calcs, commit defaults
            const c = U.calcText(k.raw, ctx.stash);
            if (c == null) return null;
            btns.push(c);
            commits.push(btns.length === 1);
          } else if (k.tag === 'Button') {
            // modern shape: <Button CommitState="True"><Calculation>…
            const c = U.calcText(k.inner, ctx.stash);
            if (c == null || c === '') return null; // unlabeled button -> learner/passthrough
            btns.push(c);
            commits.push(k.attrs.CommitState === 'True');
          } else return null;
        }
      }
      for (const b of ['Button1', 'Button2', 'Button3']) {
        const el = childByTag(els, b);
        if (el) {
          const c = U.calcText(el.inner, ctx.stash);
          if (c != null && c !== '') { btns.push(c); commits.push(btns.length === 1); }
        }
      }
      if (btns.length) parts.push('Buttons: ' + btns.join(' , '));
      // Non-default commit pattern (default: first button commits) is shown so
      // it survives the text round-trip instead of being silently reset.
      if (btns.length && commits.some((c, i) => c !== (i === 0))) {
        parts.push('Commit: ' + commits.map((c) => (c ? 'Yes' : 'No')).join(' , '));
      }
      return parts.join(' ; ');
    },
    toXml(argsStr) {
      const args = dropRestoreLabel(splitTop(argsStr, ';')).filter((p) => p !== '');
      // Reject labels the classic form doesn't know (Height:, Button2:, ...) so
      // textToXml falls through to the learned extended-dialog template instead
      // of silently dropping them.
      for (const part of args) {
        const m = /^([^:]+):/.exec(part);
        const label = m ? m[1].trim().toLowerCase() : '';
        if (label !== 'title' && label !== 'message' && label !== 'buttons' && label !== 'commit') {
          throw new Error('Show Custom Dialog: not the classic Title/Message/Buttons form');
        }
      }
      let xml = '';
      const title = labeled(args, 'Title');
      const msg = labeled(args, 'Message');
      if (title != null) xml += calcXml('Title', title);
      if (msg != null) xml += calcXml('Message', msg);
      const buttons = labeled(args, 'Buttons');
      const commitArg = labeled(args, 'Commit');
      if (buttons != null) {
        const btns = splitTop(buttons, ',').filter((b) => b !== '');
        const commits = commitArg != null ? splitTop(commitArg, ',').map((c) => parseOnOff(c) === 'True') : null;
        if (btns.length) {
          // Modern FM shape: each button calc wrapped in <Button CommitState=…>;
          // default commit pattern is first-button-only.
          xml += '<Buttons>' + btns.slice(0, 3).map((b, i) => {
            const commit = commits ? !!commits[i] : i === 0;
            return '<Button CommitState="' + (commit ? 'True' : 'False') + '"><Calculation>' + U.cdata(b) + '</Calculation></Button>';
          }).join('') + '</Buttons>';
        }
      }
      return xml;
    },
  },

  'Enter Find Mode': {
    toText(els, ctx) {
      if (!onlyTags(els, ['PauseFind', 'Pause', 'Query'])) return null;
      const restore = childByTag(els, 'Restore');
      if ((restore && restore.attrs.state === 'True') || childByTag(els, 'Query')) return null; // saved criteria -> passthrough
      const p = childByTag(els, 'PauseFind') || childByTag(els, 'Pause');
      return 'Pause: ' + (p ? onOff(p.attrs.state) : 'Off');
    },
    toXml(argsStr) {
      const v = labeled(dropRestoreLabel(splitTop(argsStr, ';')), 'Pause');
      const state = v == null ? 'False' : parseOnOff(v);
      if (state == null) throw new Error('Enter Find Mode: Pause must be On or Off');
      // modern FM exports <Pause state/>; the old <PauseFind> shape is read-only
      return '<Pause state="' + state + '"/>';
    },
  },

  'Perform Find': {
    toText(els) {
      // only the plain variant; a step with saved criteria falls through
      return els.every(isNoise) ? '' : null;
    },
    toXml(argsStr) {
      const rest = dropRestoreLabel(splitTop(argsStr, ';'));
      if (rest.length === 0) return '';
      if (rest.join(' ').trim().toLowerCase() === 'restore') {
        throw new Error('Perform Find [ Restore ] cannot be rebuilt from text: copy the step from FileMaker so its criteria round-trips via #fmxml');
      }
      throw new Error('Perform Find supports only "Perform Find [ ]" here (saved criteria round-trip via #fmxml)');
    },
  },

  'Go to Record/Request/Page': {
    // FM's own export shape is <NoInteract state/><RowPageLocation value/> (+ <Exit state/>);
    // the older <Value type="Which"> shape is accepted on read but never emitted —
    // FM's paste parser drops old-schema children inconsistently.
    toText(els, ctx) {
      if (!onlyTags(els, ['Value', 'Exit', 'NoInteract', 'RowPageLocation'])) return null;
      let w = null;
      const rowLoc = childByTag(els, 'RowPageLocation');
      if (rowLoc && rowLoc.attrs.value) w = rowLoc.attrs.value;
      const whichEl = els.find((e) => e.tag === 'Value' && e.attrs.type === 'Which');
      if (!w && whichEl) w = U.unmask(U.decodeEntities(whichEl.inner), ctx.stash).trim();
      if (!['First', 'Last', 'Next', 'Previous'].includes(w)) return null; // ByCalculation -> learned
      let out = w;
      let exitOn = null;
      const exitEl = childByTag(els, 'Exit');
      if (exitEl && 'state' in exitEl.attrs) exitOn = onOff(exitEl.attrs.state);
      const exitLast = els.find((e) => e.tag === 'Value' && e.attrs.type === 'ExitAfterLast');
      if (exitOn == null && exitLast) exitOn = onOff(U.decodeEntities(exitLast.inner).trim());
      if (exitOn === 'On') out += ' ; Exit after last: On';
      return out;
    },
    toXml(argsStr) {
      const args = dropRestoreLabel(splitTop(argsStr, ';'))
        .filter((a) => !/^nointeract\s*:/i.test(a)); // NoInteract: Off is default noise
      const which = args[0];
      if (!['First', 'Last', 'Next', 'Previous'].includes(which)) {
        throw new Error('Go to Record/Request/Page: expected First, Last, Next or Previous');
      }
      let xml = '<NoInteract state="False"/><RowPageLocation value="' + which + '"/>';
      const exitLast = labeled(args, 'Exit after last') != null ? labeled(args, 'Exit after last') : labeled(args, 'Exit');
      if (exitLast != null) {
        const st = parseOnOff(exitLast);
        if (st == null) throw new Error('Exit after last must be On or Off');
        xml += '<Exit state="' + st + '"/>';
      }
      return xml;
    },
  },

  'Perform Script': {
    toText(els, ctx) {
      if (!onlyTags(els, ['Script', 'Text', 'Calculation', 'FileReference'])) return null;
      const script = childByTag(els, 'Script');
      const textEl = childByTag(els, 'Text');
      let name = null;
      let id = null;
      if (script) { name = script.attrs.name; id = script.attrs.id || null; }
      else if (textEl) name = U.unmask(U.decodeEntities(textEl.inner), ctx.stash).trim();
      if (!name) return null;
      // external-file call: <FileReference id name><UniversalPathList>file:Name</UniversalPathList></FileReference>
      let filePart = '';
      const fileRef = childByTag(els, 'FileReference');
      if (fileRef) {
        const pathMatch = /^<UniversalPathList>([^<]*)<\/UniversalPathList>$/.exec(fileRef.inner.trim());
        if (!fileRef.attrs.name || !pathMatch || pathMatch[1] !== 'file:' + fileRef.attrs.name) return null;
        filePart = ' ; File: "' + fileRef.attrs.name + '"' + (fileRef.attrs.id ? ' ; File ID: ' + fileRef.attrs.id : '');
      }
      let out = '"' + name + '"';
      if (id) out += ' ; ID: ' + id;
      out += filePart;
      const param = U.calcText(els.map((e) => (e.tag === 'Calculation' ? e.raw : '')).join(''), ctx.stash);
      if (param != null && param !== '') out += ' ; Parameter: ' + param;
      return out;
    },
    toXml(argsStr) {
      const args = splitTop(argsStr, ';');
      const name = stripQuotes(args[0] || '');
      if (!name) throw new Error('Perform Script needs "ScriptName"');
      const id = labeled(args, 'ID');
      let xml = '';
      const file = labeled(args, 'File');
      if (file != null) {
        const fileName = stripQuotes(file);
        const fileId = labeled(args, 'File ID');
        xml += '<FileReference' + (fileId ? ' id="' + U.escapeXml(fileId) + '"' : '') +
          ' name="' + U.escapeXml(fileName) + '"><UniversalPathList>file:' + U.escapeXml(fileName) +
          '</UniversalPathList></FileReference>';
      }
      const param = labeled(args, 'Parameter');
      if (param != null && param !== '') xml += calcXml(null, param);
      xml += '<Script' + (id ? ' id="' + U.escapeXml(id) + '"' : '') + ' name="' + U.escapeXml(name) + '"/>';
      return xml;
    },
  },

  'Pause/Resume Script': {
    toText(els, ctx) {
      if (!onlyTags(els, ['Duration', 'PauseTime'])) return null;
      const pt = childByTag(els, 'PauseTime');
      if (pt && pt.attrs.value === 'Indefinitely') return 'Indefinitely';
      const d = childByTag(els, 'Duration');
      if (!d) return pt ? null : 'Indefinitely';
      const calc = U.calcText(d.inner, ctx.stash);
      return calc == null ? null : 'Duration (seconds): ' + calc;
    },
    toXml(argsStr) {
      const args = splitTop(argsStr, ';');
      const pt = labeled(args, 'PauseTime');
      const t = argsStr.trim();
      if (t === '' || /^indefinitely$/i.test(t) || (pt != null && /^indefinitely$/i.test(pt))) {
        return '<PauseTime value="Indefinitely"/>';
      }
      const dur = labeled(args, 'Duration (seconds)');
      if (dur == null) throw new Error('Pause/Resume Script: use "Indefinitely" or "Duration (seconds): n"');
      return '<PauseTime value="ForDuration"/><Duration>' + calcXml(null, dur) + '</Duration>';
    },
  },

  'Sort Records': {
    // <NoInteract state/> + <Restore state="True"/><SortList ...><Sort type="Ascending">
    // <PrimaryField><Field table name/></PrimaryField></Sort>...</SortList>
    // Text: Sort Records [ With dialog: Off ; Sort: Products::ProductName Ascending , T::F Descending ]
    // Anything fancier (summary-field reorder, value-list order, custom SortList attrs) -> passthrough.
    toText(els, ctx) {
      if (!onlyTags(els, ['NoInteract', 'Restore', 'SortList'])) return null;
      const noInteract = childByTag(els, 'NoInteract');
      const restore = childByTag(els, 'Restore');
      const sortList = childByTag(els, 'SortList');
      let out = 'With dialog: ' + (noInteract && noInteract.attrs.state === 'True' ? 'Off' : 'On');
      if (!sortList) return restore && restore.attrs.state === 'True' ? null : out;
      const a = sortList.attrs;
      if (a.BlanksLast !== 'False' || a.Maintain !== 'True' || a.value !== 'True') return null;
      const keys = [];
      for (const s of U.topLevelElements(sortList.inner)) {
        if (s.tag !== 'Sort' || !['Ascending', 'Descending'].includes(s.attrs.type)) return null;
        const prim = U.topLevelElements(s.inner);
        if (prim.length !== 1 || prim[0].tag !== 'PrimaryField') return null;
        const fields = U.topLevelElements(prim[0].inner);
        if (fields.length !== 1 || fields[0].tag !== 'Field' || !fields[0].attrs.name) return null;
        const f = fields[0].attrs;
        keys.push((f.table ? f.table + '::' : '') + f.name + ' ' + s.attrs.type);
      }
      if (!keys.length) return null;
      return out + ' ; Sort: ' + keys.join(' , ');
    },
    toXml(argsStr) {
      const args = dropRestoreLabel(splitTop(argsStr, ';'));
      const dialog = labeled(args, 'With dialog');
      const st = dialog == null ? 'True' : (parseOnOff(dialog) === 'True' ? 'False' : 'True');
      let xml = '<NoInteract state="' + st + '"/>';
      const sortSpec = labeled(args, 'Sort');
      if (sortSpec != null) {
        let sorts = '';
        for (const item of splitTop(sortSpec, ',')) {
          const m = /^(.+?)\s+(Ascending|Descending)$/i.exec(item.trim());
          if (!m) throw new Error('Sort Records: each key must be "Table::Field Ascending|Descending"');
          const fm = /^(?:([^:]+)::)?(.+)$/.exec(m[1].trim());
          const dir = m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
          sorts += '<Sort type="' + dir + '"><PrimaryField><Field' +
            (fm[1] ? ' table="' + U.escapeXml(fm[1].trim()) + '"' : '') +
            ' name="' + U.escapeXml(fm[2].trim()) + '"/></PrimaryField></Sort>';
        }
        xml += '<Restore state="True"/><SortList BlanksLast="False" Maintain="True" value="True">' + sorts + '</SortList>';
      }
      return xml;
    },
  },

  'Set Error Capture': {
    toText(els) {
      if (!onlyTags(els, ['Set'])) return null;
      const s = childByTag(els, 'Set');
      return s ? onOff(s.attrs.state) : null;
    },
    toXml(argsStr) {
      const st = parseOnOff(argsStr);
      if (st == null) throw new Error('Set Error Capture: expected On or Off');
      return '<Set state="' + st + '"/>';
    },
  },

  'Comment': {
    toText(els, ctx) {
      const kept = els.filter((e) => !isNoise(e));
      if (!kept.every((e) => e.tag === 'Text')) return null;
      const t = childByTag(kept, 'Text');
      const txt = t ? U.unmask(U.decodeEntities(t.inner), ctx.stash) : '';
      return { comment: txt };
    },
    toXml() { throw new Error('internal'); }, // comments are handled by the line parser
  },
};

// Many real-world files stamp a meaningless <Restore state="False"/> child on
// control-flow and comment steps; built-ins drop it rather than falling back to
// the noisier learned rendering.
function isNoise(el) {
  return el.tag === 'DisableStepCollapsed' || (el.tag === 'Restore' && el.attrs.state === 'False');
}

function dropRestoreLabel(args) {
  return args.filter((a) => a !== '' && !/^restore\s*:/i.test(a));
}

function calcOnlyStep(label) {
  return {
    toText(els, ctx) {
      const kept = els.filter((e) => !isNoise(e));
      if (!kept.every((e) => e.tag === 'Calculation')) return null;
      const calc = U.calcText(kept.map((e) => e.raw).join(''), ctx.stash);
      return calc == null ? null : calc;
    },
    toXml(argsStr) {
      const args = dropRestoreLabel(splitTop(argsStr, ';'));
      let calc = labeled(args, 'Calculation');
      if (calc == null) calc = args.join(' ; ').trim();
      if (!calc) throw new Error(label + ' needs a calculation');
      return calcXml(null, calc);
    },
  };
}

function bareStep() {
  return {
    toText(els) {
      return els.every(isNoise) ? '' : null;
    },
    toXml(argsStr) {
      if (dropRestoreLabel(splitTop(argsStr, ';')).length) throw new Error('this step takes no parameters');
      return '';
    },
  };
}

// --- learned-template engine -------------------------------------------------

// Attribute values that must not become refillable slots: object ids and event
// codes are re-emitted verbatim, and values that would not survive the
// "Label: value" text round-trip (empty, or whitespace-sensitive like
// FieldDelimiter="&#9;") are frozen into the skeleton.
function attrSlottable(name, value) {
  return name !== 'id' && value !== '' && value === value.trim();
}

function attrsVerbatim(el) {
  return Object.keys(el.attrs).map((k) => ' ' + k + '="' + U.escapeXml(el.attrs[k]) + '"').join('');
}

// Emit an element's attributes into the skeleton, slotting where safe.
// Labeling: an id+name pair labels the name by TAG (object refs, FM re-resolves
// by name); a single slottable attr labels by TAG (FM's generic value=/type=
// attrs) unless tagLabelTaken (the tag label is claimed by the element's text
// content), in which case tag+AttrName; several attrs are labeled by attr name.
function slotAttrs(el, spec, argParts, tagLabelTaken) {
  const keys = Object.keys(el.attrs);
  const hasIdName = keys.includes('id') && keys.includes('name');
  const slottable = keys.filter((k) => attrSlottable(k, el.attrs[k]));
  let out = '';
  for (const k of keys) {
    const v = el.attrs[k];
    if (slottable.indexOf(k) === -1) { out += ' ' + k + '="' + U.escapeXml(v) + '"'; continue; }
    let label;
    if (hasIdName && k === 'name') label = el.tag;
    else if (slottable.length === 1 && !tagLabelTaken) label = el.tag;
    else if (slottable.length === 1) label = el.tag + k.charAt(0).toUpperCase() + k.slice(1);
    else label = k;
    spec.push({ label, kind: 'attr', attr: k });
    argParts.push(label + ': ' + v);
    out += ' ' + k + '="{{' + (spec.length - 1) + '}}"';
  }
  return out;
}

// Classify one element into a refillable slot. Returns the skeleton fragment
// (may push onto spec/argParts) or null if the element isn't a simple shape.
function slotElement(el, ctx, spec, argParts, depth) {
  // FM's private clipboard format writes empty elements expanded
  // (<Set state="False"></Set>) where Script Workspace XML self-closes
  // (<Set state="False"/>); normalize so both learn identical skeletons.
  if (!el.selfClosing && el.inner.trim() === '') {
    el = { tag: el.tag, attrs: el.attrs, inner: '', raw: '<' + el.tag + attrsVerbatim(el) + '/>', selfClosing: true };
  }
  const idx = spec.length;
  // <X><Calculation>...</Calculation></X> or bare <Calculation>. A wrapper with
  // MORE than one child (e.g. <Buttons> holding several calcs) must not be
  // claimed here — calcText would silently keep only the first calc. Wrapper
  // attrs (e.g. <Button CommitState="True">) are preserved verbatim.
  const calc = U.calcText(el.tag === 'Calculation' ? el.raw : el.inner, ctx.stash);
  if (calc != null && (el.tag === 'Calculation' ||
      (/<Calculation/.test(el.inner) && U.topLevelElements(el.inner).length === 1))) {
    const label = el.tag === 'Calculation' ? 'Calculation' : el.tag;
    spec.push({ label, kind: 'calc' });
    argParts.push(label + ': ' + calc);
    return el.tag === 'Calculation'
      ? '{{' + idx + '}}'
      : '<' + el.tag + attrsVerbatim(el) + '>{{' + idx + '}}</' + el.tag + '>';
  }
  // <X state="True|False"/>
  if (el.selfClosing && 'state' in el.attrs && Object.keys(el.attrs).length === 1) {
    spec.push({ label: el.tag, kind: 'state' });
    argParts.push(el.tag + ': ' + onOff(el.attrs.state));
    return '<' + el.tag + ' state="{{' + idx + '}}"/>';
  }
  // <X anyAttr="text"/> — e.g. <FlushType value="Always"/>, <UniversalPathList type="Embedded"/>
  if (el.selfClosing && Object.keys(el.attrs).length === 1) {
    const attrName = Object.keys(el.attrs)[0];
    spec.push({ label: el.tag, kind: 'attr', attr: attrName });
    argParts.push(el.tag + ': ' + el.attrs[attrName]);
    return '<' + el.tag + ' ' + attrName + '="{{' + idx + '}}"/>';
  }
  // <X id="n" name="text"/> — object refs like <Table id="0" name=""/>; the id is
  // kept verbatim in the skeleton, FM re-resolves by name on paste.
  if (el.selfClosing && Object.keys(el.attrs).length === 2 && 'id' in el.attrs && 'name' in el.attrs) {
    spec.push({ label: el.tag, kind: 'text' });
    argParts.push(el.tag + ': ' + el.attrs.name);
    return '<' + el.tag + ' id="' + U.escapeXml(el.attrs.id) + '" name="{{' + idx + '}}"/>';
  }
  // <Boolean type="T" value="True|False"/>
  if (el.tag === 'Boolean' && el.attrs.type && 'value' in el.attrs) {
    spec.push({ label: el.attrs.type, kind: 'bool' });
    argParts.push(el.attrs.type + ': ' + onOff(el.attrs.value));
    return '<Boolean type="' + U.escapeXml(el.attrs.type) + '" value="{{' + idx + '}}"/>';
  }
  // <Value type="T">text</Value>
  if (el.tag === 'Value' && el.attrs.type && !/</.test(el.inner)) {
    const v = U.unmask(U.decodeEntities(el.inner), ctx.stash).trim();
    spec.push({ label: el.attrs.type, kind: 'text' });
    argParts.push(el.attrs.type + ': ' + v);
    return '<Value type="' + U.escapeXml(el.attrs.type) + '">{{' + idx + '}}</Value>';
  }
  // <Field table="T" name="F"/>
  if (el.tag === 'Field' && el.attrs.name != null) {
    const ref = (el.attrs.table ? el.attrs.table + '::' : '') + el.attrs.name;
    spec.push({ label: 'Field', kind: 'field' });
    argParts.push('Field: ' + ref);
    return '{{' + idx + '}}';
  }
  // plain text tag <X>text</X>. A CDATA-wrapped blob (e.g. Print's
  // PlatformData) cannot be a text slot — re-escaping it would turn the CDATA
  // wrapper into literal data. Plain '<' in text is fine (escapes cleanly).
  if (!el.selfClosing && !/</.test(el.inner) && Object.keys(el.attrs).length === 0) {
    const v = U.unmask(U.decodeEntities(el.inner), ctx.stash).trim();
    if (v.indexOf('<![CDATA[') !== -1) return null;
    spec.push({ label: el.tag, kind: 'text' });
    argParts.push(el.tag + ': ' + v);
    return '<' + el.tag + '>{{' + idx + '}}</' + el.tag + '>';
  }
  // bare self-closing tag with no attrs — kept verbatim, no slot
  if (el.selfClosing && Object.keys(el.attrs).length === 0) return el.raw;
  // <X a="1" b="2"/> — multi-attribute self-closing tag (e.g. Speak's
  // <SpeechOptions WaitForCompletion="False" VoiceId="0"/>). Specific shapes
  // (state, Boolean, id+name refs, Field) are claimed by the earlier cases;
  // label collisions across children make learnStep decline to passthrough.
  if (el.selfClosing) {
    return '<' + el.tag + slotAttrs(el, spec, argParts, false) + '/>';
  }
  // <X attr="v">text</X> — attribute(s) plus text content (e.g. Insert
  // Picture's <UniversalPathList type="Reference">$path</UniversalPathList>):
  // the text is labeled by TAG, the attr by tag+AttrName.
  if (!/</.test(el.inner)) {
    const v = U.unmask(U.decodeEntities(el.inner), ctx.stash).trim();
    if (v.indexOf('<![CDATA[') !== -1) return null; // CDATA blob — see above
    const attrSkel = slotAttrs(el, spec, argParts, true);
    spec.push({ label: el.tag, kind: 'text' });
    argParts.push(el.tag + ': ' + v);
    return '<' + el.tag + attrSkel + '>{{' + (spec.length - 1) + '}}</' + el.tag + '>';
  }
  // container of simple children, recursively (FM's PDF/window/notification
  // steps nest up to 4-5 levels). Attributes slot like any tag's. Text mixed
  // between child elements would be lost, so mixed content declines.
  if (depth < 5) {
    const kids = U.topLevelElements(el.inner);
    if (!kids.length) return null;
    let leftover = el.inner;
    for (const k of kids) leftover = leftover.replace(k.raw, '');
    if (leftover.trim()) return null;
    // Rollback point: if any child declines, the attr/child slots pushed so
    // far must be withdrawn — otherwise they'd survive as dead parameters
    // (editable-looking text that no longer maps to any skeleton placeholder)
    // when learnStep falls back to sealing the whole element as a #blob.
    const specLen = spec.length;
    const argLen = argParts.length;
    const attrSkel = slotAttrs(el, spec, argParts, false);
    let innerSkel = '';
    for (const k of kids) {
      const f = slotElement(k, ctx, spec, argParts, depth + 1);
      if (f == null) { spec.length = specLen; argParts.length = argLen; return null; }
      innerSkel += f;
    }
    return '<' + el.tag + attrSkel + '>' + innerSkel + '</' + el.tag + '>';
  }
  return null;
}

// Sealed-envelope fallback for children no slot rule understands (binary
// print settings, import field maps): the child's exact XML rides in the text
// line as a compressed base64 "#blob …" value and is inflated verbatim on
// rebuild. Readable options stay editable; opaque data stays byte-exact.
function blobEncode(rawXml) {
  return '#blob ' + zlib.deflateSync(Buffer.from(rawXml, 'utf8')).toString('base64');
}

function blobDecode(value, label, name) {
  const m = /^#blob\s+([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (!m) {
    throw new Error(name + ': ' + label + ' expects a "#blob …" value (opaque data captured from a real FileMaker copy) - re-paste this step from FileMaker to obtain one.');
  }
  try {
    return zlib.inflateSync(Buffer.from(m[1], 'base64')).toString('utf8');
  } catch (e) {
    throw new Error(name + ': ' + label + ' #blob data is corrupted - re-paste this step from FileMaker.');
  }
}

// Try to decompose a step's children into refillable slots. Returns
// { paramSpec: [{label, kind}], skeleton, args } or null if not slottable.
// Skeleton placeholders: {{0}}, {{1}}, ...
function learnStep(name, els, ctx) {
  const spec = [];
  const argParts = [];
  let skeleton = '';
  for (const el of els) {
    // textToXml adds DisableStepCollapsed itself; keeping it here would duplicate it.
    if (el.tag === 'DisableStepCollapsed') continue;
    const specLen = spec.length;
    const argLen = argParts.length;
    let frag = slotElement(el, ctx, spec, argParts, 0);
    // A single child exploding into this many params (an import field map's
    // per-field entries) is not sensibly line-editable — seal it instead.
    if (frag != null && spec.length - specLen > 12) {
      spec.length = specLen;
      argParts.length = argLen;
      frag = null;
    }
    if (frag == null) {
      // complex child -> sealed envelope (see blobEncode above)
      spec.push({ label: el.tag, kind: 'raw' });
      argParts.push(el.tag + ': ' + blobEncode(U.unmask(el.raw, ctx.stash)));
      frag = '{{' + (spec.length - 1) + '}}';
    }
    skeleton += frag;
  }
  // A step needing this many slots (Import Records' per-field mapping) is not
  // sensibly editable as one text line — passthrough serves it better.
  if (spec.length > 40) return null;
  // Duplicate labels get numeric suffixes in document order (Button, Button2,
  // Button3 — matching FM's own Button1..3 naming) so repeated children stay
  // addressable; spec[i] and argParts[i] are always pushed in lockstep.
  const seen = {};
  spec.forEach((p, i) => {
    seen[p.label] = (seen[p.label] || 0) + 1;
    if (seen[p.label] > 1) {
      const label = p.label + seen[p.label];
      argParts[i] = label + argParts[i].slice(p.label.length);
      p.label = label;
    }
  });
  // Still ambiguous after suffixing (a real tag named Button2 collides with a
  // renamed duplicate) — decline, passthrough is safer.
  const labels = spec.map((p) => p.label);
  if (new Set(labels).size !== labels.length) return null;
  return { paramSpec: spec, skeleton, args: argParts.join(' ; ') };
}

// If placeholder {{i}} is the ONLY slot inside one standalone element of the
// skeleton, return the skeleton with that element removed; else null. FM omits
// unset children in its own exports, so dropping the element reproduces
// exactly what FM emits when the option is not set — the param is optional.
function dropSlotElement(skeleton, i) {
  const ph = '{{' + i + '}}';
  const at = skeleton.indexOf(ph);
  if (at === -1) return null;
  const start = skeleton.lastIndexOf('<', at);
  if (start === -1) return null;
  const open = /^<([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/.exec(skeleton.slice(start));
  if (!open) return null;
  let element = null;
  if (open[3]) {
    // self-closing tag: placeholder must live in its attributes
    if (start + open[0].length > at) element = open[0];
  } else {
    // <Tag attrs>{{i}}</Tag> with the placeholder as the entire content
    const close = '</' + open[1] + '>';
    if (start + open[0].length === at && skeleton.startsWith(close, at + ph.length)) {
      element = skeleton.slice(start, at + ph.length + close.length);
    }
  }
  if (!element) return null;
  if ((element.match(/\{\{\d+\}\}/g) || []).length !== 1) return null; // other slots depend on it
  return skeleton.slice(0, start) + skeleton.slice(start + element.length);
}

// Slots whose fragment IS a whole child (kind 'field', and a bare <Calculation>)
// sit in the skeleton as a lone "{{i}}" between siblings, with no element of
// their own for dropSlotElement to find. Omitting them is still "option not
// set" — Insert from URL writes its result into a variable instead of a field,
// Open URL carries no URL calculation — so remove the placeholder. Only called
// after dropSlotElement declines, so a placeholder that fills a wrapper element
// still drops the wrapper with it rather than leaving <CURLOptions></CURLOptions>.
function dropBareSlot(skeleton, i) {
  const ph = '{{' + i + '}}';
  const at = skeleton.indexOf(ph);
  if (at === -1) return null;
  const before = skeleton.slice(0, at);
  const after = skeleton.slice(at + ph.length);
  // "Element level" = not inside a tag's angle brackets. Testing the brackets
  // rather than the immediately adjacent characters keeps this correct when two
  // bare slots sit side by side ("…/>{{5}}{{6}}", Insert from URL's URL
  // calculation followed by its target field).
  if (before.lastIndexOf('<') > before.lastIndexOf('>')) return null;
  const nextOpen = after.indexOf('<');
  const nextClose = after.indexOf('>');
  if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) return null;
  return before + after;
}

function fillTemplate(tpl, argsStr, name) {
  const args = splitTop(argsStr, ';').filter((p) => p !== '');
  const consumed = new Array(args.length).fill(false);
  const take = (label) => {
    for (let i = 0; i < args.length; i++) {
      if (consumed[i]) continue;
      const m = /^([^:]+):\s*([\s\S]*)$/.exec(args[i]);
      if (m && m[1].trim().toLowerCase() === label.toLowerCase()) { consumed[i] = true; return m[2].trim(); }
    }
    return null;
  };
  // Pass 1: claim arguments by their "Label: value" prefix, under either the
  // template's own (XML tag) label or one of FileMaker's display labels.
  const ownLabels = new Set(tpl.paramSpec.map((p) => p.label.toLowerCase()));
  const takeFor = (p) => {
    const own = take(p.label);
    if (own != null) return own;
    for (const alias of PARAM_ALIASES[p.label] || []) {
      if (ownLabels.has(alias.label.toLowerCase())) continue; // a real slot owns that word
      const v = take(alias.label);
      if (v == null) continue;
      if (!alias.invert) return v;
      const st = parseOnOff(v);
      if (st == null) throw new Error(name + ': ' + alias.label + ' must be On or Off');
      return st === 'True' ? 'Off' : 'On'; // FM's "With dialog" is NOT NoInteract
    }
    return null;
  };
  const values = tpl.paramSpec.map(takeFor);
  // Pass 2: FileMaker's display syntax asserts a boolean option by NAME alone —
  // "Insert from URL [ Select ; With dialog: Off ; … ]" means SelectAll is on.
  // This has to run before the positional pass below, or a bare flag word gets
  // poured into the first free calculation slot as though it were a value.
  for (let i = 0; i < args.length; i++) {
    if (consumed[i]) continue;
    const word = args[i].trim().toLowerCase();
    for (let p = 0; p < values.length; p++) {
      const spec = tpl.paramSpec[p];
      if (values[p] != null || (spec.kind !== 'state' && spec.kind !== 'bool')) continue;
      const aliases = PARAM_ALIASES[spec.label] || [];
      if (spec.label.toLowerCase() !== word && !aliases.some((a) => a.label.toLowerCase() === word)) continue;
      // Naming the option asserts it — except for a display label that negates
      // the stored flag, where asserting "With dialog" means NoInteract is off.
      const alias = aliases.find((a) => a.label.toLowerCase() === word);
      values[p] = alias && alias.invert ? 'Off' : 'On';
      consumed[i] = true;
      break;
    }
  }

  // Pass 3: FileMaker's own display syntax writes single-parameter steps without
  // a label — "Allow User Abort [ Off ]", not "[ Set: Off ]" — and that is what
  // people type. Hand each still-unclaimed UNLABELED argument to the next empty
  // slot that could hold it, in document order. An argument that does carry a
  // label is never placed positionally: an unrecognized label means the template
  // is missing that parameter, which must be reported (see `extra` below) rather
  // than silently poured into the wrong slot.
  for (let i = 0; i < args.length; i++) {
    if (consumed[i] || looksLabeled(args[i])) continue;
    for (let p = 0; p < values.length; p++) {
      if (values[p] != null) continue;
      const kind = tpl.paramSpec[p].kind;
      if (kind === 'raw') continue; // #blob payloads are only ever written labeled
      // On/Off slots refuse a non-boolean, so a calculation cannot land in a
      // toggle merely by being the first empty slot.
      if ((kind === 'state' || kind === 'bool') && parseOnOff(args[i]) == null) continue;
      values[p] = args[i];
      consumed[i] = true;
      break;
    }
  }

  let xml = tpl.skeleton;
  tpl.paramSpec.forEach((p, i) => {
    let v = values[i];
    if (v == null) {
      // Omitted raw blob = the option was never set; emit nothing for it.
      if (p.kind === 'raw') { xml = xml.split('{{' + i + '}}').join(''); return; }
      // Omitted param: drop its element (= FM's "option not set") when possible.
      const dropped = dropSlotElement(xml, i);
      if (dropped != null) { xml = dropped; return; }
      // Same, for a slot that is a whole child with no element of its own.
      const bare = dropBareSlot(xml, i);
      if (bare != null) { xml = bare; return; }
      // Otherwise drop just the attribute (FM omits unset attrs too — e.g.
      // NewWndStyles carries fewer attrs when ShowInNewWindow is off).
      const attrRe = new RegExp('\\s[\\w:.-]+\\s*=\\s*"\\{\\{' + i + '\\}\\}"');
      if (attrRe.test(xml)) { xml = xml.replace(attrRe, ''); return; }
      throw new Error(name + ': missing "' + p.label + ':"');
    }
    if (p.kind === 'raw') {
      xml = xml.split('{{' + i + '}}').join(blobDecode(v, p.label, name));
      return;
    }
    if (p.kind === 'state' || p.kind === 'bool') {
      const st = parseOnOff(v);
      if (st == null) throw new Error(name + ': ' + p.label + ' must be On or Off');
      v = st;
    } else if (p.kind === 'attr') {
      v = U.escapeXml(v.trim());
    } else if (p.kind === 'calc') {
      v = '<Calculation>' + U.cdata(v) + '</Calculation>';
    } else if (p.kind === 'field') {
      const m = /^(?:([^:]+)::)?(.+)$/.exec(v.trim());
      v = '<Field' + (m[1] ? ' table="' + U.escapeXml(m[1].trim()) + '"' : '') + ' name="' + U.escapeXml(m[2].trim()) + '"/>';
    } else {
      // 'text' slots hold a literal (a layout/script/window name, a path), not a
      // calculation. FileMaker's display syntax quotes those names and so do
      // users copying from it; a literal that both begins and ends with a quote
      // is never what was meant, so unwrap it.
      v = U.escapeXml(stripQuotes(v.trim()));
    }
    xml = xml.split('{{' + i + '}}').join(v);
  });
  // A leftover labeled arg means the text carries a parameter this template
  // has no slot for (learned from a leaner instance) — dropping it silently
  // would alter the step on paste, so surface it instead.
  const extra = args.filter((_, i) => !consumed[i]);
  if (extra.length) {
    throw new Error(name + ': unknown parameter "' + extra[0].split(':')[0].trim() +
      '" - not in this step\'s learned template. Re-copy this step from FileMaker (' +
      KEYS.paste + ') to refresh the template.');
  }
  return xml;
}

// --- XML -> text -------------------------------------------------------------

function xmlToText(xml, store) {
  const warnings = [];
  const { masked, stash } = U.maskCdata(xml);
  const ctx = { stash };
  const stepRe = /<Step\b((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/>|>([\s\S]*?)<\/Step>)/g;
  const lines = [];
  let depth = 0;
  let m;
  while ((m = stepRe.exec(masked))) {
    const attrs = U.parseAttrs(m[1]);
    // FM's clipboard name for comment steps is "# (comment)"; some step names
    // carry a trailing space in the XML (e.g. "Configure RAG Account ") — the
    // trimmed form is used everywhere, the raw form is preserved for re-emission.
    const rawName = (attrs.name === '# (comment)' ? 'Comment' : attrs.name) || '';
    const name = rawName.trim();
    const enabled = attrs.enable !== 'False';
    const inner = m[3] || '';
    const els = U.topLevelElements(inner);
    // Collapse FileMaker's pretty-printing between tags (CDATA is masked, so this
    // is safe) so passthrough steps stay on one readable #fmxml line when possible.
    const rawStep = U.unmask(m[0].replace(/>\s+</g, '><'), stash);

    let line = null;
    const builtin = BUILTINS[name];
    if (builtin) {
      const res = builtin.toText(els, ctx);
      if (res != null && typeof res === 'object' && 'comment' in res) {
        line = res.comment.trim() === '' ? '' : '# ' + res.comment;
      } else if (res != null) {
        line = stepLineText(name, res);
        if (name === 'Perform Script' && res.indexOf('"<unknown>"') !== -1) {
          warnings.push('A Perform Script step\'s target is "<unknown>" - the reference is broken in FileMaker itself (the target script did not exist in the file it was pasted into). Fix it in FileMaker via Specify.');
        }
      }
    }
    if (line == null && name !== 'Comment') {
      const learned = learnStep(name, els, ctx);
      if (learned) {
        if (store) {
          store.templates = store.templates || {};
          const prev = store.templates[name];
          const next = { paramSpec: learned.paramSpec, skeleton: learned.skeleton, id: attrs.id || (prev && prev.id) || '1' };
          if (rawName !== name) next.xmlName = rawName;
          // Keep the stored template when it already knows every parameter
          // this instance uses AND can build it (omitted slots drop) — a leaner
          // paste must never clobber a richer template. Comparison is by
          // parameter LABEL, not emitted XML: reference elements freeze an
          // id (Table/Script/Layout) that legitimately differs per instance,
          // so exact-XML equality would spuriously fail and let the lean
          // shape win. Only store the new template when it introduces a label
          // the stored one lacks, or the stored one can't build this instance.
          let keepPrev = false;
          if (prev) {
            const prevLabels = new Set(prev.paramSpec.map((p) => p.label));
            const nextAddsNothing = next.paramSpec.every((p) => prevLabels.has(p.label));
            if (nextAddsNothing) {
              try { fillTemplate(prev, learned.args, name); keepPrev = true; } catch (e) { keepPrev = false; }
            }
          }
          if (!keepPrev) {
            store.templates[name] = next;
            store.dirty = true;
          }
        }
        line = stepLineText(name, learned.args);
      }
    }
    if (line == null) {
      const hasNewline = rawStep.indexOf(String.fromCharCode(10)) !== -1 || rawStep.indexOf(String.fromCharCode(13)) !== -1;
      if (!hasNewline) {
        line = '#fmxml ' + rawStep;
      } else {
        line = '#fmxml64 ' + name.replace(/\s/g, '_') + ' ' + Buffer.from(rawStep, 'utf8').toString('base64');
      }
      warnings.push('"' + name + '" kept as raw XML (complex step) - it will paste back into FileMaker unchanged.');
    }

    if (DEDENT_BEFORE.has(name)) depth = Math.max(0, depth - 1);
    const prefix = INDENT.repeat(depth) + (enabled ? '' : '// ');
    lines.push(line === '' && !line.startsWith('#') ? prefix.trimEnd() : prefix + line);
    if (INDENT_AFTER.has(name)) depth++;
  }
  return { text: lines.join('\n') + (lines.length ? '\n' : ''), warnings };
}

// --- text -> XML -------------------------------------------------------------

// knownNames is sorted longest-first so "Set Field By Name" wins over "Set Field".
// `norm` must preserve length — the matched prefix is sliced off `trimmed` by
// the step name's own length.
function matchStepName(trimmed, knownNames, norm) {
  const t = norm(trimmed);
  for (const n of knownNames) {
    const k = norm(n);
    if (t === k) return { name: n, args: '' };
    if (t.startsWith(k)) {
      const rest = trimmed.slice(n.length).trim();
      if (rest.startsWith('[') && rest.endsWith(']')) {
        return { name: n, args: rest.slice(1, -1).trim() };
      }
    }
  }
  return null;
}

function parseStepLine(trimmed, knownNames) {
  // returns { name, args } or null
  const exact = matchStepName(trimmed, knownNames, (s) => s);
  if (exact) return exact;
  // FileMaker's own capitalization is not self-consistent ("Set Field By Name"
  // vs. the "by" most people type) and hand-edited lines drift in case. A step
  // that differs only in case is that step, not an unknown one.
  return matchStepName(trimmed, knownNames, (s) => s.toLowerCase());
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Best-effort "did you mean" for a genuinely unknown step. Case and punctuation
// differences already resolve in parseStepLine, so what reaches here is a real
// typo — which prefix matching misses ("Alow User Abort" shares two letters with
// "Allow User Abort"). Only ever used to enrich an error message; the list is a
// couple of hundred names, so the quadratic distance is free.
function closestStepName(typed, knownNames) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(typed);
  if (t.length < 4) return null;
  let best = null;
  let bestDist = Infinity;
  const limit = Math.max(2, Math.floor(t.length / 5));
  for (const n of knownNames) {
    const k = norm(n);
    if (Math.abs(k.length - t.length) > limit) continue;
    const d = editDistance(t, k);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return bestDist <= limit ? best : null;
}

// Update bracket depth across a physical line, respecting FM string literals
// (with backslash escapes; strings may contain literal newlines, so inStr
// carries across lines) and // calc comments (which run to end of line).
function scanLine(line, state) {
  let depth = state.depth;
  let inStr = state.inStr;
  let brokeOnComment = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '/' && line[i + 1] === '/') { brokeOnComment = true; break; }
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
  }
  return { depth, inStr, brokeOnComment };
}

// Render "Name [ args ]". If the args end inside a // calc comment (e.g. a
// multi-line calculation whose last line is a comment), a trailing " ]" would
// be swallowed by that comment — put the closing bracket on its own line.
function stepLineText(name, args) {
  if (args === '') return name;
  const NL = String.fromCharCode(10);
  const candidate = name + ' [ ' + args;
  let state = { depth: 0, inStr: false, brokeOnComment: false };
  for (const ln of candidate.split(NL)) state = scanLine(ln, state);
  return state.brokeOnComment ? candidate + NL + ']' : candidate + ' ]';
}

function textToXml(text, store) {
  const warnings = [];
  const errors = [];
  const templates = (store && store.templates) || {};
  const knownNames = Array.from(new Set([...Object.keys(BUILTINS), ...Object.keys(templates)]))
    .sort((a, b) => b.length - a.length);
  const out = [];
  const NL = String.fromCharCode(10);
  const src = text.replace(/\r\n/g, NL).split(NL);
  // Trailing blank lines are file padding, not spacer comments.
  let last = src.length;
  while (last > 0 && src[last - 1].trim() === '') last--;

  // Group physical lines into logical steps: a step whose [ ... ] spans several
  // lines (multi-line calculations) is joined before parsing. Comment/#fmxml
  // lines and blank lines are always single.
  const logical = [];
  for (let i = 0; i < last; i++) {
    const startNo = i + 1;
    const trimmed = src[i].trim();
    const afterDisable = trimmed.startsWith('//') ? trimmed.replace(/^\/\/\s?/, '') : trimmed;
    if (trimmed === '' || afterDisable.startsWith('#')) {
      logical.push({ lineNo: startNo, text: trimmed });
      continue;
    }
    let acc = trimmed;
    let state = scanLine(afterDisable, { depth: 0, inStr: false });
    while ((state.depth > 0 || state.inStr) && i + 1 < last) {
      i++;
      acc += NL + src[i]; // continuation lines kept verbatim (calc content)
      state = scanLine(src[i], state);
    }
    if (state.depth > 0 || state.inStr) {
      errors.push('line ' + startNo + ': step bracket "[" or string never closes');
      continue;
    }
    logical.push({ lineNo: startNo, text: acc });
  }

  for (const entry of logical) {
    const lineNo = entry.lineNo;
    let t = entry.text.trim();
    let enable = 'True';
    if (t.startsWith('// ') || t === '//') {
      enable = 'False';
      t = t.slice(2).trim();
    }
    const open = '<Step enable="' + enable + '" id="1" name="';

    // FileMaker resolves pasted steps by NAME first, falling back to the id
    // attribute. Its real name for comment steps is "# (comment)" — emitting
    // name="Comment" made FM fall back to id 1, which is Perform Script.
    if (t === '') {
      out.push(open + '# (comment)"><DisableStepCollapsed state="False"/></Step>');
      continue;
    }
    if (t.startsWith('#fmxml64 ')) {
      const m = /^#fmxml64\s+\S+\s+([A-Za-z0-9+/=]+)$/.exec(t);
      if (!m) { errors.push('line ' + lineNo + ': malformed #fmxml64 directive'); continue; }
      out.push(Buffer.from(m[1], 'base64').toString('utf8'));
      continue;
    }
    if (t.startsWith('#fmxml ')) {
      out.push(t.slice(7).trim());
      continue;
    }
    if (t.startsWith('#')) {
      const txt = t.replace(/^#\s?/, '');
      out.push(open + '# (comment)"><DisableStepCollapsed state="False"/><Text>' + U.escapeXml(txt) + '</Text></Step>');
      continue;
    }

    const parsed = parseStepLine(t, knownNames);
    if (!parsed) {
      const typed = t.split('[')[0].trim();
      const near = closestStepName(typed, knownNames);
      errors.push('line ' + lineNo + ': unrecognized step "' + typed + '"' +
        (near ? ' (did you mean "' + near + '"?)' : '') +
        ' - no built-in or learned template. Copy this step from FileMaker once (' +
        KEYS.paste + ') so FM Bridge learns its XML.');
      continue;
    }
    try {
      let inner;
      let tplUsed = null;
      if (BUILTINS[parsed.name] && parsed.name !== 'Comment') {
        try {
          inner = BUILTINS[parsed.name].toXml(parsed.args);
        } catch (builtinErr) {
          // A modern variant of a built-in step (e.g. "Loop [ Restore: Off ; FlushType: Always ]")
          // may not fit the classic shape but have a learned template — try that before failing.
          if (templates[parsed.name]) {
            tplUsed = templates[parsed.name];
            inner = fillTemplate(tplUsed, parsed.args, parsed.name);
          } else throw builtinErr;
        }
      } else {
        tplUsed = templates[parsed.name];
        inner = fillTemplate(tplUsed, parsed.args, parsed.name);
      }
      // Learned steps carry the real FM step id and raw XML name captured at learn
      // time — FM resolves by name first, but a correct id is the safety net.
      // Builtins borrow the id from a learned template of the same step when one
      // exists, so builtin- and template-emitted steps are byte-identical.
      const tplInfo = tplUsed || templates[parsed.name];
      const stepId = tplInfo && tplInfo.id ? tplInfo.id : '1';
      const stepName = tplInfo && tplInfo.xmlName ? tplInfo.xmlName : parsed.name;
      const body = '<DisableStepCollapsed state="False"/>' + inner;
      out.push('<Step enable="' + enable + '" id="' + U.escapeXml(stepId) + '" name="' +
        U.escapeXml(stepName) + '">' + body + '</Step>');
    } catch (e) {
      errors.push('line ' + lineNo + ': ' + e.message);
    }
  }

  const xml = '<fmxmlsnippet type="FMObjectList">' + out.join('') + '</fmxmlsnippet>';
  return { xml, warnings, errors, stepCount: out.length };
}

module.exports = { xmlToText, textToXml, BUILTINS, INDENT_AFTER, DEDENT_BEFORE, KEYS };
