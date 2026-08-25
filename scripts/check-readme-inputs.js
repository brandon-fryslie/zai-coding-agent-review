#!/usr/bin/env node
// Enforce that each shipped action's README "## Inputs" table matches its action.yml. [LAW:single-enforcer]
//
// action.yml is the ONE authoritative input contract — the keys the runner reads.
// The README inputs table is a DERIVED representation of that contract, and (since
// the action is published) the Marketplace listing body a prospective consumer
// reads before adopting. Two representations of one contract can drift: a new input
// added to action.yml with no README row under-documents the action; a README row
// for an input that no longer exists is a promise the action can't keep. [LAW:one-source-of-truth]
//
// kx9.7 reconciled the table BY HAND; nothing mechanically stopped the drift from
// recurring. This is the machine that does — so the "every input is documented,
// nothing documents a phantom input" invariant has a type, not a hope. [LAW:types-are-the-program]
// It mirrors ci.yml's committed-dist freshness check: a pure check of the working
// tree, failing the build loudly on divergence. [LAW:no-silent-failure]
//
// Scope is the structured inputs table ONLY. The Providers table and intro prose are
// free-text, not a 1:1 map of inputs, and are deliberately not gated.
//
// Usage: node scripts/check-readme-inputs.js   (run from the repo root)
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '..');

// EVERY action this repo ships, as data. The rule is one rule; an action is an INSTANCE of it, so a
// second shipped action is a row here and nothing else. [LAW:one-type-per-behavior]
// It deliberately lives in the script rather than being passed in from ci.yml: the workflow would then
// hold the enumeration, and "is every shipped action covered?" would be answerable only by reading a file
// that explains none of this — which is the same by-hand vigilance this script exists to replace, moved
// up one level. The gap that reached review was exactly this shape one layer over: a dist-freshness gate
// covering one of the build's two bundles still reported green. A gate over a SUBSET of the surface it
// names is worse than none, because the check reads as coverage. [LAW:no-silent-failure]
const MANIFESTS = [
  { action: 'action.yml', readme: 'README.md' },
  { action: 'dismiss-block/action.yml', readme: 'dismiss-block/README.md' },
];

// One pair's whole verdict, returned as a list of complaints rather than exiting where it finds them:
// every pair is checked before anything terminates, so one run names every fix — the same reason the
// three divergence classes below are collected instead of short-circuiting. [LAW:effects-at-boundaries]
function checkPair({ action: actionRel, readme: readmeRel }) {
  const problems = [];

  // SOURCE OF TRUTH: the inputs the runner actually reads.
  const action = yaml.parse(fs.readFileSync(path.join(root, actionRel), 'utf8'));
  const actionInputs = Object.keys(action?.inputs ?? {});
  if (actionInputs.length === 0) {
    return {
      count: 0,
      problems: [`${actionRel} declares no inputs — cannot validate ${readmeRel}'s table against an empty contract.`],
    };
  }

  // DERIVED: the keys documented in the README "## Inputs" table. Scope to that
  // section (heading to the next "## " heading OR end of document), then take each
  // table row whose first cell is a backtick-quoted key. The Providers table and
  // prose live outside this slice.
  const readme = fs.readFileSync(path.join(root, readmeRel), 'utf8');
  const section = readme.match(/(?:^|\n)## Inputs\n([\s\S]*?)(?=\n## |$)/);
  if (!section) return { count: actionInputs.length, problems: [`${readmeRel} has no "## Inputs" section to validate against ${actionRel}.`] };
  const documented = [...section[1].matchAll(/^\|\s*`([A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]);

  const actionSet = new Set(actionInputs);
  const documentedSet = new Set(documented);

  // Three divergence classes, all surfaced together so one run names every fix.
  const missing = actionInputs.filter((k) => !documentedSet.has(k)); // input with no README row
  const orphan = documented.filter((k) => !actionSet.has(k));        // README row with no input
  const duplicate = documented.filter((k, i) => documented.indexOf(k) !== i); // a key rowed twice

  if (missing.length) problems.push(`inputs in ${actionRel} with NO ${readmeRel} row: ${missing.join(', ')}`);
  if (orphan.length) problems.push(`${readmeRel} rows for inputs NOT in ${actionRel}: ${orphan.join(', ')}`);
  if (duplicate.length) problems.push(`inputs documented by more than one ${readmeRel} row: ${[...new Set(duplicate)].join(', ')}`);

  return { count: actionInputs.length, problems };
}

const results = MANIFESTS.map((m) => ({ ...m, ...checkPair(m) }));
const failed = results.filter((r) => r.problems.length > 0);

if (failed.length > 0) {
  console.error('An inputs table is out of sync with its action.yml:');
  for (const r of failed) for (const p of r.problems) console.error(`  • ${p}`);
  console.error('Reconcile each README inputs table with its action.yml (the source of truth), then re-run.');
  process.exit(1);
}

for (const r of results) {
  console.log(`✓ ${r.readme} inputs table matches ${r.action} (${r.count} inputs, no missing/orphan/duplicate rows).`);
}
