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

let added = 0;
let updated = 0;
for (const name of Object.keys(ws)) {
  if (!(name in starter)) added++;
  else if (JSON.stringify(starter[name]) !== JSON.stringify(ws[name])) updated++;
  else continue;
  starter[name] = ws[name];
}

// Stable output: sorted keys so diffs stay readable.
const sorted = {};
for (const name of Object.keys(starter).sort()) sorted[name] = starter[name];
fs.writeFileSync(starterPath, JSON.stringify(sorted, null, 2) + '\n');

console.log('starter templates: ' + Object.keys(sorted).length + ' total (' + added + ' added, ' + updated + ' updated)');
