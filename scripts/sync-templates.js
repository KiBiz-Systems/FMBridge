// Merge this workspace's learned templates (.fmbridge/templates.json) into the
// starter set bundled with the extension (lib/starter-templates.json).
// Run before packaging a release so everything learned here ships to all users.
//
// Usage: npm run sync-templates

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wsPath = path.join(root, '.fmbridge', 'templates.json');
const starterPath = path.join(root, 'lib', 'starter-templates.json');

if (!fs.existsSync(wsPath)) {
  console.log('nothing to sync: no ' + path.relative(root, wsPath));
  process.exit(0);
}

const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
const starter = fs.existsSync(starterPath) ? JSON.parse(fs.readFileSync(starterPath, 'utf8')) : {};

// FileMaker omits children whose option is unset, so copying an UNCONFIGURED
// step teaches a template with fewer slots than a configured one. At runtime
// xmlToText guards against that (a leaner paste never clobbers a richer stored
// template); this script used to overwrite unconditionally, which is how the
// shipped "Insert from URL" lost its URL and cURL-options slots and "Close
// Window" lost its Name slot. Same rule here: only take the workspace template
// when it knows a parameter the starter one does not.
function labelsOf(tpl) {
  return new Set((tpl.paramSpec || []).map((p) => p.label));
}

let added = 0;
let updated = 0;
let kept = 0;
for (const name of Object.keys(ws)) {
  const prev = starter[name];
  if (!prev) {
    added++;
  } else if (JSON.stringify(prev) === JSON.stringify(ws[name])) {
    continue;
  } else {
    const have = labelsOf(prev);
    if ([...labelsOf(ws[name])].every((l) => have.has(l))) {
      console.log('  keeping richer starter template for "' + name + '" (workspace copy adds no parameter)');
      kept++;
      continue;
    }
    updated++;
  }
  const next = Object.assign({}, ws[name]);
  // Older captures predate step-id tracking; don't lose an id the starter has.
  if (!next.id && prev && prev.id) next.id = prev.id;
  starter[name] = next;
}

// Stable output: sorted keys so diffs stay readable.
const sorted = {};
for (const name of Object.keys(starter).sort()) sorted[name] = starter[name];
fs.writeFileSync(starterPath, JSON.stringify(sorted, null, 2) + '\n');

console.log('starter templates: ' + Object.keys(sorted).length + ' total (' + added + ' added, ' +
  updated + ' updated, ' + kept + ' kept richer)');
