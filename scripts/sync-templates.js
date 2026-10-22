// Merge this workspace's learned templates (.fmbridge/templates.json) into the
// starter set bundled with the extension for one FileMaker version
// (lib/versions/<name>/templates.json).
// Run before packaging a release so everything learned here ships to all users.
//
// Usage: npm run sync-templates                 asks which FileMaker, if anything is new
//        npm run sync-templates -- --fm 2025    (the FileMaker the steps were copied from)

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const versions = require('../lib/versions');

const root = path.join(__dirname, '..');
const wsPath = path.join(root, '.fmbridge', 'templates.json');

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

function addsParameter(tpl, prev) {
  const have = labelsOf(prev);
  return [...labelsOf(tpl)].some((l) => !have.has(l));
}

function sync(fm, ws) {
  const starterPath = versions.ownTemplatesPath(fm);
  // Compare against the resolved set so an unchanged inherited template isn't copied in.
  const own = fs.existsSync(starterPath) ? JSON.parse(fs.readFileSync(starterPath, 'utf8')) : {};
  const resolved = versions.loadVersion(fm).templates;

  let added = 0;
  let updated = 0;
  let kept = 0;
  for (const name of Object.keys(ws)) {
    const prev = resolved[name];
    if (!prev) {
      added++;
    } else if (JSON.stringify(prev) === JSON.stringify(ws[name])) {
      continue;
    } else {
      if (!addsParameter(ws[name], prev)) {
        console.log('  keeping richer starter template for "' + name + '" (workspace copy adds no parameter)');
        kept++;
        continue;
      }
      updated++;
    }
    const next = Object.assign({}, ws[name]);
    // Older captures predate step-id tracking; don't lose an id the starter has.
    if (!next.id && prev && prev.id) next.id = prev.id;
    own[name] = next;
  }

  // Stable output: sorted keys so diffs stay readable.
  const sorted = {};
  for (const name of Object.keys(own).sort()) sorted[name] = own[name];
  fs.writeFileSync(starterPath, JSON.stringify(sorted, null, 2) + '\n');

  console.log('FM ' + fm + ' starter templates: ' + Object.keys(sorted).length + ' own (' + added +
    ' added, ' + updated + ' updated, ' + kept + ' kept richer)');
}

// Learned templates no supported version has yet: missing everywhere, or richer
// than every version's copy. Anything already synced into some version is not new.
function newTemplates(ws) {
  const sets = versions.VERSIONS.map((v) => versions.loadVersion(v).templates);
  return Object.keys(ws).filter((name) => sets.every((t) => !t[name] || addsParameter(ws[name], t[name])))
    .map((name) => name + (sets.some((t) => t[name]) ? ' (richer)' : ''));
}

// Only whoever trained knows which FileMaker the steps came from, and a wrong
// guess ships one version's steps to users of another — so never default.
function askVersion(found) {
  const shown = found.slice(0, 10).join(', ') + (found.length > 10 ? ', +' + (found.length - 10) + ' more' : '');
  console.log(found.length + ' learned template(s) to sync: ' + shown);
  const choices = versions.VERSIONS.map((v, i) => '[' + (i + 1) + '] ' + versions.label(v)).join('  ');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const ask = () => rl.question('Which FileMaker were they copied from?  ' + choices + '  [s] skip: ', (answer) => {
      const a = answer.trim().toLowerCase();
      const v = versions.VERSIONS[Number(a) - 1] || (versions.VERSIONS.includes(a) ? a : null);
      if (a !== 's' && !v) return ask();
      rl.close();
      resolve(a === 's' ? null : v);
    });
    ask();
  });
}

async function main() {
  const fmArg = process.argv.indexOf('--fm');
  const given = fmArg !== -1 ? String(process.argv[fmArg + 1]) : null;
  if (given !== null && !versions.VERSIONS.includes(given)) {
    console.error('unsupported FileMaker version "' + given + '" (supported: ' + versions.VERSIONS.join(', ') + ')');
    process.exit(1);
  }
  if (!fs.existsSync(wsPath)) {
    console.log('nothing to sync: no ' + path.relative(root, wsPath));
    return;
  }
  const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
  if (given) return sync(given, ws);

  const found = newTemplates(ws);
  if (!found.length) {
    console.log('nothing new to sync in ' + path.relative(root, wsPath));
    return;
  }
  if (!process.stdin.isTTY) {
    console.error(found.length + ' learned template(s) to sync, but no terminal to ask which FileMaker they came from. ' +
      'Run: ' + versions.VERSIONS.map((v) => 'npm run sync-templates -- --fm ' + v).join('  or  '));
    process.exit(1);
  }
  const fm = await askVersion(found);
  if (!fm) {
    console.log('skipped: nothing synced');
    return;
  }
  sync(fm, ws);
}

main();
