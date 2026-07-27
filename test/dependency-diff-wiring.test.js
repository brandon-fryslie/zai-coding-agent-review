'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveDependencyDiffNote, MAX_DEPENDENCY_BUMPS_FETCHED } = require('../src/run');

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

describe('resolveDependencyDiffNote', () => {
  test('off (dependencyDiffOn=false) fetches nothing and returns empty', async () => {
    const files = [{ filename: 'go.mod', patch: goModPatchFor([{ modulePath: 'github.com/a/b', from: 'v1.0.0', to: 'v1.1.0' }]) }];
    let calls = 0;
    const note = await resolveDependencyDiffNote(stubOctokit(() => calls++), files, false);
    assert.equal(note, '');
    assert.equal(calls, 0);
  });

  test('no go.mod in the diff returns empty even when the feature is on', async () => {
    const files = [{ filename: 'main.go', patch: '@@ -1,1 +1,1 @@\n-a\n+b' }];
    const note = await resolveDependencyDiffNote(stubOctokit(), files, true);
    assert.equal(note, '');
  });

  test('fetches upstream context for every bump up to the cap', async () => {
    const bumps = Array.from({ length: MAX_DEPENDENCY_BUMPS_FETCHED }, (_, i) => ({ modulePath: `github.com/org/mod${i}`, from: 'v1.0.0', to: 'v1.1.0' }));
    const files = [{ filename: 'go.mod', patch: goModPatchFor(bumps) }];
    let calls = 0;
    const note = await resolveDependencyDiffNote(stubOctokit(() => calls++), files, true);
    assert.equal(calls, MAX_DEPENDENCY_BUMPS_FETCHED);
    for (const b of bumps) assert.ok(note.includes(b.modulePath), b.modulePath);
    assert.ok(!note.includes('bumps more than'));
  });

  test('bumps beyond the cap are reported as skipped, not silently dropped, and never fetched', async () => {
    const bumps = Array.from({ length: MAX_DEPENDENCY_BUMPS_FETCHED + 3 }, (_, i) => ({ modulePath: `github.com/org/mod${i}`, from: 'v1.0.0', to: 'v1.1.0' }));
    const files = [{ filename: 'go.mod', patch: goModPatchFor(bumps) }];
    let calls = 0;
    const note = await resolveDependencyDiffNote(stubOctokit(() => calls++), files, true);
    assert.equal(calls, MAX_DEPENDENCY_BUMPS_FETCHED, 'only the capped number of modules are fetched');
    assert.ok(note.includes('bumps more than'));
    const lastSkipped = bumps[bumps.length - 1].modulePath;
    assert.ok(note.includes(lastSkipped), 'a skipped module is still named in the note, not dropped');
  });
});
