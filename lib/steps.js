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
//      user's file (lib/versions/base/builtins.js). Bijective: text form
//      regenerates equivalent XML.
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

// Built-ins and display labels come from the selected FileMaker version
// (lib/versions loadVersion), so the store must carry them.
function versionData(store) {
  if (!store || !store.builtins) throw new Error('store has no builtins - build it from lib/versions loadVersion()');
  return { builtins: store.builtins, paramAliases: store.paramAliases || {} };
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

function fillTemplate(tpl, argsStr, name, aliasMap) {
  const paramAliases = aliasMap || {};
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
    for (const alias of paramAliases[p.label] || []) {
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
      const aliases = paramAliases[spec.label] || [];
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
  const { builtins, paramAliases } = versionData(store);
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
    const builtin = builtins[name];
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
              try { fillTemplate(prev, learned.args, name, paramAliases); keepPrev = true; } catch (e) { keepPrev = false; }
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
  const { builtins, paramAliases } = versionData(store);
  const knownNames = Array.from(new Set([...Object.keys(builtins), ...Object.keys(templates)]))
    .sort((a, b) => b.length - a.length);
  // store.unavailable: { stepName: [other versions that have it] }
  const unavailable = {};
  for (const name of Object.keys((store && store.unavailable) || {})) {
    if (knownNames.includes(name)) continue;
    unavailable[name.toLowerCase()] = { name, versions: store.unavailable[name] };
  }
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
      const elsewhere = unavailable[typed.toLowerCase()];
      if (elsewhere) {
        errors.push('line ' + lineNo + ': "' + elsewhere.name + '" is not available in FM ' +
          store.version + ' (it exists in ' + elsewhere.versions.map((v) => 'FM ' + v).join(', ') +
          ') - check the FileMaker version setting');
        continue;
      }
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
      if (builtins[parsed.name] && parsed.name !== 'Comment') {
        try {
          inner = builtins[parsed.name].toXml(parsed.args);
        } catch (builtinErr) {
          // A modern variant of a built-in step (e.g. "Loop [ Restore: Off ; FlushType: Always ]")
          // may not fit the classic shape but have a learned template — try that before failing.
          if (templates[parsed.name]) {
            tplUsed = templates[parsed.name];
            inner = fillTemplate(tplUsed, parsed.args, parsed.name, paramAliases);
          } else throw builtinErr;
        }
      } else {
        tplUsed = templates[parsed.name];
        inner = fillTemplate(tplUsed, parsed.args, parsed.name, paramAliases);
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

module.exports = {
  xmlToText, textToXml, INDENT_AFTER, DEDENT_BEFORE, KEYS,
  helpers: { childByTag, onOff, parseOnOff, splitTop, stripQuotes, labeled },
};
