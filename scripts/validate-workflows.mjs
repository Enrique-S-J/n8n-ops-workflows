#!/usr/bin/env node
// Structural validation for the workflow JSON in ./workflows.
//
// Two levels of checking:
//
//   1. Always: the export is parseable and internally consistent — every node
//      carries the fields n8n needs, ids and names are unique, and every node
//      referenced in `connections` actually exists in `nodes`. A dangling
//      connection imports without an error and then silently does nothing,
//      which is the worst way for a workflow to be broken.
//
//   2. If `n8n-nodes-base` is resolvable: each node's `type` is a real node and
//      its `typeVersion` is one the installed n8n actually implements. This is
//      what catches the "unknown node type" and "this node version is not
//      supported" errors on import.
//
// Run: node scripts/validate-workflows.mjs
// Deep check: npm i --no-save n8n-nodes-base && node scripts/validate-workflows.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = resolve(here, '..', 'workflows');

const REQUIRED_NODE_FIELDS = ['id', 'name', 'type', 'typeVersion', 'position'];

const errors = [];
const notes = [];

/** Load the installed n8n node registry, if there is one. */
function loadRegistry() {
  const require = createRequire(import.meta.url);
  let pkgPath;
  try {
    pkgPath = require.resolve('n8n-nodes-base/package.json');
  } catch {
    return null;
  }

  const base = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const registry = new Map();

  for (const rel of pkg.n8n?.nodes ?? []) {
    let mod;
    try {
      mod = require(join(base, rel));
    } catch {
      // Some nodes pull in n8n-core, which is not installed for a check this
      // shallow. Skip them rather than failing the whole run.
      continue;
    }

    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      let inst;
      try {
        inst = new exported();
      } catch {
        continue;
      }

      const desc = inst.description ?? inst.baseDescription;
      if (!desc?.name) continue;

      const versions = inst.nodeVersions
        ? Object.keys(inst.nodeVersions).map(Number)
        : [desc.version].flat().map(Number);

      registry.set(`n8n-nodes-base.${desc.name}`, new Set(versions));
    }
  }

  return registry.size > 0 ? registry : null;
}

const registry = loadRegistry();
notes.push(
  registry
    ? `Node registry loaded: ${registry.size} node types available for deep checking.`
    : 'n8n-nodes-base not installed — running structural checks only.',
);

const files = readdirSync(workflowDir).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) errors.push('No workflow JSON found in workflows/.');

for (const file of files) {
  const path = join(workflowDir, file);
  const label = `workflows/${file}`;

  let wf;
  try {
    wf = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    errors.push(`${label}: does not parse as JSON — ${e.message}`);
    continue;
  }

  for (const key of ['name', 'nodes', 'connections', 'settings']) {
    if (!(key in wf)) errors.push(`${label}: missing top-level "${key}".`);
  }
  if (!Array.isArray(wf.nodes)) {
    errors.push(`${label}: "nodes" is not an array.`);
    continue;
  }

  const names = new Set();
  const ids = new Set();

  for (const node of wf.nodes) {
    const label2 = `${label} node "${node.name ?? '(unnamed)'}"`;

    for (const field of REQUIRED_NODE_FIELDS) {
      if (node[field] === undefined) errors.push(`${label2}: missing "${field}".`);
    }

    if (names.has(node.name)) errors.push(`${label2}: duplicate node name.`);
    names.add(node.name);

    if (ids.has(node.id)) errors.push(`${label2}: duplicate node id "${node.id}".`);
    ids.add(node.id);

    // n8n generates UUIDs for node ids. Nothing breaks if one is malformed, but
    // a hand-written export drifting off the format is a sign it was edited by
    // hand without care, so hold the line.
    if (typeof node.id === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.id)) {
      errors.push(`${label2}: id "${node.id}" is not a well-formed UUID.`);
    }

    if (!Array.isArray(node.position) || node.position.length !== 2) {
      errors.push(`${label2}: "position" must be a [x, y] pair.`);
    }

    if (typeof node.type === 'string' && !node.type.startsWith('n8n-nodes-base.')) {
      errors.push(`${label2}: type "${node.type}" is not a built-in node; this workflow is meant to import with no extra installs.`);
    }

    if (registry && typeof node.type === 'string') {
      const versions = registry.get(node.type);
      if (!versions) {
        errors.push(`${label2}: unknown node type "${node.type}".`);
      } else if (!versions.has(Number(node.typeVersion))) {
        errors.push(
          `${label2}: typeVersion ${node.typeVersion} not supported by "${node.type}" (available: ${[...versions].join(', ')}).`,
        );
      }
    }

    // A credential must be referenced by name, never carry an inline secret.
    const raw = JSON.stringify(node.parameters ?? {});
    if (/(sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{20,})/.test(raw)) {
      errors.push(`${label2}: looks like it contains an inline API key or bearer token.`);
    }
  }

  // Every endpoint named in connections has to be a real node, in both
  // directions — source keys and destination targets.
  for (const [source, outputs] of Object.entries(wf.connections ?? {})) {
    if (!names.has(source)) {
      errors.push(`${label}: connections reference source node "${source}", which does not exist.`);
    }
    for (const branch of outputs.main ?? []) {
      for (const conn of branch ?? []) {
        if (!names.has(conn.node)) {
          errors.push(`${label}: "${source}" connects to "${conn.node}", which does not exist.`);
        }
      }
    }
  }

  // A node with no inbound and no outbound connection is orphaned on the canvas.
  const connected = new Set(Object.keys(wf.connections ?? {}));
  for (const outputs of Object.values(wf.connections ?? {})) {
    for (const branch of outputs.main ?? []) {
      for (const conn of branch ?? []) connected.add(conn.node);
    }
  }
  for (const name of names) {
    if (!connected.has(name)) errors.push(`${label}: node "${name}" is not connected to anything.`);
  }

  notes.push(`${label}: ${wf.nodes.length} nodes, ${Object.keys(wf.connections ?? {}).length} connected sources — OK`);
}

for (const note of notes) console.log(note);

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`\nAll ${files.length} workflows valid.`);
