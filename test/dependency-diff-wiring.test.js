'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveDependencySummaries, MAX_DEPENDENCY_BUMPS_FETCHED } = require('../src/run');

// A stub octokit whose compareCommits never touches the network — every module here resolves via
// the direct github.com/... path, so resolveModuleRepo needs no fetchImpl call either.
function stubOctokit(onCall) {
  return {
    rest: {
      repos: {
        compareCommits: async ({ owner, repo, base, head }) => {
          if (onCall) onCall();
          return {
            data: {
              html_url: `https://github.com/${owner}/${repo}/compare/${base}...${head}`,
              commits: [{ sha: 'a'.repeat(40), commit: { message: 'a commit' } }],
              files: [{ filename: 'file.go' }],
            },
          };
        },
      },
    },
  };
}

function goModPatchFor(bumps) {
  const lines = ['@@ -1,1 +1,1 @@'];
  for (const b of bumps) {
    lines.push(`-\t${b.modulePath} ${b.from}`);
    lines.push(`+\t${b.modulePath} ${b.to}`);
  }
  return lines.join('\n');
}

const modulesOf = summaries => summaries.map(s => s.modulePath);

describe('resolveDependencySummaries', () => {
  test('off (dependencyDiffOn=false) fetches nothing and returns []', async () => {
    const files = [{ filename: 'go.mod', patch: goModPatchFor([{ modulePath: 'github.com/a/b', from: 'v1.0.0', to: 'v1.1.0' }]) }];
    let calls = 0;
    const summaries = await resolveDependencySummaries(stubOctokit(() => calls++), files, false);
    assert.deepEqual(summaries, []);
    assert.equal(calls, 0);
  });

  test('no go.mod in the diff returns [] even when the feature is on', async () => {
    const files = [{ filename: 'main.go', patch: '@@ -1,1 +1,1 @@\n-a\n+b' }];
    const summaries = await resolveDependencySummaries(stubOctokit(), files, true);
    assert.deepEqual(summaries, []);
  });

  test('fetches upstream context for every bump up to the cap, each resolved', async () => {
    const bumps = Array.from({ length: MAX_DEPENDENCY_BUMPS_FETCHED }, (_, i) => ({ modulePath: `github.com/org/mod${i}`, from: 'v1.0.0', to: 'v1.1.0' }));
    const files = [{ filename: 'go.mod', patch: goModPatchFor(bumps) }];
    let calls = 0;
    const summaries = await resolveDependencySummaries(stubOctokit(() => calls++), files, true);
    assert.equal(calls, MAX_DEPENDENCY_BUMPS_FETCHED);
    for (const b of bumps) assert.ok(modulesOf(summaries).includes(b.modulePath), b.modulePath);
    assert.ok(summaries.every(s => s.resolved), 'every fetched bump resolves');
  });

  test('bumps beyond the cap are carried as resolved:false, not silently dropped, and never fetched', async () => {
    const bumps = Array.from({ length: MAX_DEPENDENCY_BUMPS_FETCHED + 3 }, (_, i) => ({ modulePath: `github.com/org/mod${i}`, from: 'v1.0.0', to: 'v1.1.0' }));
    const files = [{ filename: 'go.mod', patch: goModPatchFor(bumps) }];
    let calls = 0;
    const summaries = await resolveDependencySummaries(stubOctokit(() => calls++), files, true);
    assert.equal(calls, MAX_DEPENDENCY_BUMPS_FETCHED, 'only the capped number of modules are fetched');
    const skipped = summaries.filter(s => !s.resolved);
    assert.equal(skipped.length, 3, 'the over-cap bumps are present as unresolved, not dropped');
    assert.ok(skipped.every(s => /bumps more than/.test(s.reason)));
    const lastSkipped = bumps[bumps.length - 1].modulePath;
    assert.ok(modulesOf(summaries).includes(lastSkipped), 'a skipped module is still present, not dropped');
  });

  test('a bump in a NESTED go.mod (monorepo submodule) is covered, not just the root file', async () => {
    const rootBump = { modulePath: 'github.com/org/root-dep', from: 'v1.0.0', to: 'v1.1.0' };
    const nestedBump = { modulePath: 'github.com/org/nested-dep', from: 'v2.0.0', to: 'v2.1.0' };
    const files = [
      { filename: 'go.mod', patch: goModPatchFor([rootBump]) },
      { filename: 'tools/go.mod', patch: goModPatchFor([nestedBump]) },
    ];
    let calls = 0;
    const summaries = await resolveDependencySummaries(stubOctokit(() => calls++), files, true);
    assert.equal(calls, 2);
    assert.ok(modulesOf(summaries).includes(rootBump.modulePath));
    assert.ok(modulesOf(summaries).includes(nestedBump.modulePath));
  });

  test('a vendored go.mod is excluded — it describes the vendored dependency, not this project', async () => {
    const rootBump = { modulePath: 'github.com/org/root-dep', from: 'v1.0.0', to: 'v1.1.0' };
    const vendoredBump = { modulePath: 'github.com/other/vendored-dep', from: 'v3.0.0', to: 'v3.1.0' };
    const files = [
      { filename: 'go.mod', patch: goModPatchFor([rootBump]) },
      { filename: 'vendor/github.com/pressly/goose/go.mod', patch: goModPatchFor([vendoredBump]) },
    ];
    let calls = 0;
    const summaries = await resolveDependencySummaries(stubOctokit(() => calls++), files, true);
    assert.equal(calls, 1, 'only the root bump is fetched');
    assert.ok(modulesOf(summaries).includes(rootBump.modulePath));
    assert.ok(!modulesOf(summaries).includes(vendoredBump.modulePath));
  });
});
