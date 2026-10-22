// Round-trip stability test for the fm-bridge converters (no VS Code needed).
//
// Starting from a real .fmscript authored for a FileMaker project:
//   text0 -> xml1 -> text1 -> xml2 -> text2
// must satisfy xml1 === xml2 and text1 === text2 (the canonical forms are
// fixed points), with zero conversion errors at every stage.
//
// Run with: npm test   (or: node test/roundtrip.test.js [path/to/file.fmscript])

const fs = require('fs');
const path = require('path');
const { xmlToText, textToXml } = require('../lib/steps');
const versions = require('../lib/versions');

const fixtureDir = path.join(__dirname, 'fixtures');
const templates = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'templates.json'), 'utf8'));
const scriptPath = process.argv[2] || path.join(fixtureDir, 'sample.fmscript');
const text0 = fs.readFileSync(scriptPath, 'utf8');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ok  ' : '  FAIL') + ' ' + label + (ok || !detail ? '' : '\n        ' + detail));
  if (!ok) failures++;
}

console.log('round-trip: ' + path.basename(scriptPath));

const fm2025 = versions.loadVersion('2025');
const store = { builtins: fm2025.builtins, paramAliases: fm2025.paramAliases, templates };

const r1 = textToXml(text0, store);
check('text -> xml: no errors', r1.errors.length === 0, r1.errors.join('; '));
check('text -> xml: steps emitted', r1.stepCount > 0, 'stepCount = ' + r1.stepCount);

const t1 = xmlToText(r1.xml, store);
const r2 = textToXml(t1.text, store);
check('xml -> text -> xml: no errors', r2.errors.length === 0, r2.errors.join('; '));
check('xml stable across round-trip', r1.xml === r2.xml);

const t2 = xmlToText(r2.xml, store);
check('text stable across round-trip', t1.text === t2.text);
check('step count preserved', r2.stepCount === r1.stepCount,
  r1.stepCount + ' vs ' + r2.stepCount);

// The snippet wrapper FileMaker expects must be present.
check('fmxmlsnippet wrapper', /^<fmxmlsnippet type="FMObjectList">[\s\S]*<\/fmxmlsnippet>$/.test(r1.xml));

// --- authoring against the shipped starter templates -------------------------
// The round-trip above only proves the converters agree with themselves. These
// check that a step can be TYPED the way FileMaker displays it and rebuilt from
// the templates users actually get in the .vsix — the three ways that failed in
// 0.1.20: a bare unlabeled value, an omitted optional child, and a step name
// whose only difference is capitalization.

console.log('\nauthoring from starter templates');
const starter = { builtins: fm2025.builtins, paramAliases: fm2025.paramAliases, templates: fm2025.templates };

function authors(label, line, mustContain) {
  const r = textToXml(line, starter);
  if (r.errors.length) return check(label, false, r.errors[0]);
  const missing = (mustContain || []).filter((s) => r.xml.indexOf(s) === -1);
  check(label, missing.length === 0, 'missing from XML: ' + missing.join(' | ') + '\n        got: ' + r.xml);
}

// FileMaker writes "Allow User Abort [ Off ]", not "[ Set: Off ]".
authors('bare value fills the only slot', 'Allow User Abort [ Off ]',
  ['name="Allow User Abort"', '<Set state="False"/>']);
authors('labeled form still works', 'Allow User Abort [ Set: On ]', ['<Set state="True"/>']);
authors('step name is case-insensitive', 'allow user abort [ Off ]', ['name="Allow User Abort"']);

// Insert from URL must be able to carry a URL and cURL options at all, and must
// tolerate a variable target (FileMaker omits <Field> then).
authors('Insert from URL carries its URL', 'Insert from URL [ Calculation: "https://example.com" ]',
  ['name="Insert from URL"', '<Calculation><![CDATA["https://example.com"]]></Calculation>']);
authors('Insert from URL carries cURL options',
  'Insert from URL [ CURLOptions: "--show-error" ; Calculation: $url ; Field: T::F ]',
  ['<CURLOptions>', '<Field table="T" name="F"/>']);
authors('omitted optional child just drops out', 'Insert from URL [ NoInteract: On ]',
  ['<NoInteract state="True"/>']);
authors('Close Window keeps its Name slot', 'Close Window [ Window: Name ; Name: "Report" ]',
  ['<Name><Calculation><![CDATA["Report"]]></Calculation></Name>']);

// A field reference contains "::" and must not be mistaken for a "Label:" prefix.
authors('field reference is not read as a label', 'Set Selection [ Field: Products::Name ]',
  ['<Field table="Products" name="Name"/>']);

// FileMaker's Script Workspace display syntax — what people read off the screen
// and what an LLM asked for a FileMaker script writes. Labels differ from the
// XML tag names the template keys on, and booleans are asserted by bare word.
authors('display labels resolve to template slots',
  'Insert from URL [ With dialog: Off ; Target: T::F ; URL: "https://x" ; cURL options: "-X POST" ]',
  ['<NoInteract state="True"/>', '<Field table="T" name="F"/>',
    '<Calculation><![CDATA["https://x"]]></Calculation>', '<CURLOptions>']);
// "With dialog" is the NEGATION of the stored NoInteract flag.
authors('With dialog: On means NoInteract off', 'Insert from URL [ With dialog: On ; URL: "https://x" ]',
  ['<NoInteract state="False"/>']);
// A bare flag word must set its flag, not fall into the next free value slot.
authors('bare flag word sets its own flag',
  'Insert from URL [ Select ; With dialog: Off ; URL: "https://x" ]',
  ['<SelectAll state="True"/>', '<NoInteract state="True"/>']);
const flagNotValue = textToXml('Insert from URL [ Select ; URL: "https://x" ]', starter);
check('bare flag word never becomes a calculation',
  flagNotValue.xml.indexOf('CDATA[Select]') === -1, flagNotValue.xml);

// "#" is the comment marker; "//" means a disabled STEP, and only that.
authors('# is the comment marker', '# just a note from the model',
  ['name="# (comment)"', '<Text>just a note from the model</Text>']);
authors('// disables a real step', '// Allow User Abort [ Off ]',
  ['enable="False"', 'name="Allow User Abort"', '<Set state="False"/>']);

// An unknown step still fails, but says what was probably meant.
const unknown = textToXml('Alow User Abort [ Off ]', starter);
check('typo suggests the real step',
  unknown.errors.length === 1 && /did you mean "Allow User Abort"/.test(unknown.errors[0]),
  unknown.errors[0]);

// A labeled parameter the template has no slot for must still be reported, not
// quietly poured into the next free slot by the positional fallback.
const bogus = textToXml('Allow User Abort [ Wibble: On ]', starter);
check('unknown labeled parameter is reported',
  bogus.errors.length === 1 && /unknown parameter "Wibble"/.test(bogus.errors[0]),
  bogus.errors.join('; '));

// --- FileMaker version scoping ------------------------------------------------

console.log('\nFileMaker version scoping');
for (const name of versions.VERSIONS) {
  const v = versions.loadVersion(name);
  check('FM ' + name + ' loads templates and autocomplete data',
    Object.keys(v.templates).length > 0 && v.functions.length > 0 && v.extraStepNames.length > 0);
  if (v.extends) {
    const parent = versions.loadLayer(v.extends).templates;
    const lost = Object.keys(parent).filter((n) => !v.templates[n]);
    const from = v.extends === versions.BASE ? 'base' : 'FM ' + v.extends;
    check('FM ' + name + ' inherits ' + from + "'s templates",
      lost.length === 0, 'missing: ' + lost.join(', '));
  }
}
check('unknown FileMaker version is refused', (() => {
  try { versions.loadVersion('19'); return false; } catch (e) { return true; }
})());

const scoped = Object.assign({}, starter, { version: '2025',
  unavailable: { 'Configure Future Thing': ['2026'] } });
const future = textToXml('configure future thing [ On ]', scoped);
check('step from another version names the version it needs',
  future.errors.length === 1 && /not available in FM 2025 \(it exists in FM 2026\)/.test(future.errors[0]),
  future.errors.join('; '));
const learnedAnyway = textToXml('Allow User Abort [ Off ]',
  Object.assign({}, starter, { version: '2025', unavailable: { 'Allow User Abort': ['2026'] } }));
check('a step this version knows is never blocked', learnedAnyway.errors.length === 0, learnedAnyway.errors.join('; '));

const { BUILTINS, PARAM_ALIASES } = require('../lib/versions/base/builtins');
const overridden = { version: '2026', templates: starter.templates,
  builtins: Object.assign({}, BUILTINS, { 'Set Error Capture': {
    toText: () => 'On', toXml: () => '<NewShape state="True"/>' } }),
  paramAliases: Object.assign({}, PARAM_ALIASES, { NoInteract: [{ label: 'Silently' }] }) };
check('per-version built-in is used for that version',
  textToXml('Set Error Capture [ On ]', overridden).xml.indexOf('<NewShape state="True"/>') !== -1);
check('per-version display label is used for that version',
  textToXml('Insert from URL [ Silently: On ; URL: "https://x" ]', overridden).xml.indexOf('<NoInteract state="True"/>') !== -1);
check('display label replaced in that version is gone there',
  textToXml('Insert from URL [ With dialog: Off ; URL: "https://x" ]', overridden).errors.length === 1);
check('FM 2025 built-ins are the base set', versions.loadVersion('2025').builtins['Set Variable'] === BUILTINS['Set Variable']);
check('converters refuse a store without built-ins', (() => {
  try { textToXml('Beep', { templates: {} }); return false; } catch (e) { return /builtins/.test(e.message); }
})());

if (failures) {
  console.error('\n' + failures + ' check(s) failed');
  process.exit(1);
}
console.log('\nall checks passed');
