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

const store = { templates };

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

if (failures) {
  console.error('\n' + failures + ' check(s) failed');
  process.exit(1);
}
console.log('\nall checks passed');
