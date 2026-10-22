'use strict';

// Built-in steps and FileMaker display labels for the base version. A FileMaker
// version folder's builtins.js replaces or adds entries on top of these.

const U = require('../../xmlutil');
const { childByTag, onOff, parseOnOff, splitTop, stripQuotes, labeled } = require('../../steps').helpers;

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

module.exports = { BUILTINS, PARAM_ALIASES };
