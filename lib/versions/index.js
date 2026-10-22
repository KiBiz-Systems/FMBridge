'use strict';

// Per-version bundled data. base/ holds what every supported version has; each
// FileMaker release folder (2025, 2026) `extends` another and holds only its own
// differences, so any of its files may be absent. See CLAUDE.md.

const fs = require('fs');
const path = require('path');

const VERSIONS = ['2025', '2026'];
const DEFAULT_VERSION = '2025';
const BASE = 'base';

function readJson(p, fallback) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
}

function versionDir(name) {
  return path.join(__dirname, String(name));
}

function ownTemplatesPath(name) {
  return path.join(versionDir(name), 'templates.json');
}

const cache = new Map();

function requireIfPresent(p) {
  return fs.existsSync(p) ? require(p) : {};
}

// Parent's data, then this layer's additions and replacements, minus removed steps.
function loadLayer(name) {
  if (cache.has(name)) return cache.get(name);

  const info = readJson(path.join(versionDir(name), 'version.json'), {});
  if (info.name != null && String(info.name) !== name) {
    throw new Error('lib/versions/' + name + '/version.json says name "' + info.name + '" - it must match the folder');
  }
  if (name !== BASE && info.extends == null) {
    throw new Error('lib/versions/' + name + '/version.json must say which version it extends');
  }
  const parent = name === BASE
    ? { templates: {}, builtins: {}, paramAliases: {}, functions: [], getFlags: [], extraStepNames: [] }
    : loadLayer(String(info.extends));
  const fmdata = requireIfPresent(path.join(versionDir(name), 'fmdata.js'));
  const own = requireIfPresent(path.join(versionDir(name), 'builtins.js'));
  const removed = new Set(info.removedSteps || []);

  const templates = Object.assign({}, parent.templates, readJson(ownTemplatesPath(name), {}));
  const builtins = Object.assign({}, parent.builtins, own.BUILTINS);
  for (const step of removed) { delete templates[step]; delete builtins[step]; }
  const merge = (a, b) => Array.from(new Set([...a, ...(b || [])]));

  const v = {
    name,
    major: info.major == null ? null : info.major,
    minor: info.minor == null ? null : info.minor,
    extends: info.extends == null ? null : String(info.extends),
    templates,
    builtins,
    paramAliases: Object.assign({}, parent.paramAliases, own.PARAM_ALIASES),
    functions: merge(parent.functions, fmdata.FUNCTIONS),
    getFlags: merge(parent.getFlags, fmdata.GET_FLAGS),
    extraStepNames: merge(parent.extraStepNames, fmdata.EXTRA_STEP_NAMES).filter((n) => !removed.has(n)),
  };
  cache.set(name, v);
  return v;
}

// A selectable FileMaker version (not base).
function loadVersion(name) {
  name = String(name);
  if (!VERSIONS.includes(name)) throw new Error('unsupported FileMaker version "' + name + '"');
  return loadLayer(name);
}

// Steps only other versions have, mapped to those versions.
function unavailableSteps(name) {
  const mine = loadVersion(name);
  const names = (v) => [...Object.keys(v.builtins), ...Object.keys(v.templates), ...v.extraStepNames];
  const have = new Set(names(mine));
  const out = {};
  for (const other of VERSIONS) {
    if (other === String(name)) continue;
    const v = loadVersion(other);
    for (const step of names(v)) {
      if (have.has(step)) continue;
      (out[step] = out[step] || []).push(other);
    }
  }
  return out;
}

function label(name) {
  return 'FM ' + loadVersion(name).name;
}

module.exports = {
  VERSIONS, DEFAULT_VERSION, BASE, loadVersion, loadLayer, unavailableSteps, ownTemplatesPath, label,
};
