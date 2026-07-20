'use strict';

// CDATA sections can contain anything (quotes, <, pilcrows, newlines), so every
// regex-based pass first masks them out, then unmasks extracted values.
// The sentinel is U+0001, written as an escape so no raw control bytes live in source.
const MARK = '\u0001';
const MARK_RE = /\u0001(\d+)\u0001/g;

function maskCdata(s) {
  const stash = [];
  const masked = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => {
    stash.push(m);
    return MARK + (stash.length - 1) + MARK;
  });
  return { masked, stash };
}

function unmask(s, stash) {
  return s.replace(MARK_RE, (m, i) => stash[+i]);
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  // Tab/CR/LF become numeric refs: literal whitespace inside attribute values
  // (e.g. FieldDelimiter="&#9;") would be normalized to spaces by XML parsers.
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

function cdata(s) {
  // A calc containing "]]>" would break the section; split it across two.
  return '<![CDATA[' + String(s).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>';
}

function parseAttrs(attrsRaw) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrsRaw || ''))) attrs[m[1]] = decodeEntities(m[2]);
  return attrs;
}

// List the depth-0 child elements of a masked XML fragment.
function topLevelElements(masked) {
  const els = [];
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let depth = 0;
  let cur = null;
  let m;
  while ((m = re.exec(masked))) {
    const full = m[0];
    const close = m[1];
    const tag = m[2];
    const attrsRaw = m[3];
    const selfClose = m[4];
    if (close) {
      depth--;
      if (depth === 0 && cur && cur.tag === tag) {
        cur.inner = masked.slice(cur.innerStart, m.index);
        cur.raw = masked.slice(cur.start, m.index + full.length);
        delete cur.start;
        delete cur.innerStart;
        els.push(cur);
        cur = null;
      }
    } else if (selfClose) {
      if (depth === 0) {
        els.push({ tag, attrs: parseAttrs(attrsRaw), inner: '', raw: full, selfClosing: true });
      }
    } else {
      if (depth === 0) {
        cur = { tag, attrs: parseAttrs(attrsRaw), start: m.index, innerStart: m.index + full.length, selfClosing: false };
      }
      depth++;
    }
  }
  return els;
}

// Pull the calculation text out of a masked fragment that contains
// <Calculation>...</Calculation> (directly, or as the fragment itself).
function calcText(maskedFragment, stash) {
  if (maskedFragment == null) return null;
  let inner = maskedFragment;
  const m = /<Calculation(?:\s[^>]*)?>([\s\S]*?)<\/Calculation>/.exec(maskedFragment);
  if (m) {
    inner = m[1];
  } else if (/</.test(maskedFragment)) {
    // Fragment contains markup but no Calculation element: not a calc.
    return null;
  }
  inner = unmask(inner, stash).trim();
  const cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  if (cd) return cd[1];
  // Handle FM's occasional multi-CDATA concatenation
  if (inner.startsWith('<![CDATA[')) {
    return inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  }
  return decodeEntities(inner);
}

module.exports = { maskCdata, unmask, decodeEntities, escapeXml, cdata, parseAttrs, topLevelElements, calcText, MARK };
