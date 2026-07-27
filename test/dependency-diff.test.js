'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  parseDependencyDiffFlag,
  parseGoModBumps,
  resolveModuleRepo,
  fetchUpstreamChangeSummary,
  renderDependencyDiffNote,
  refFor,
  isPublicAddress,
  isSafeHost,
} = require('../src/dependency-diff');

// A fetchImpl that throws if ever called — proves a code path resolves WITHOUT a network call.
const noNetwork = async () => { throw new Error('network should not have been used for this path'); };
// A lookupImpl that throws if ever called — proves a code path never reaches DNS resolution.
const noDns = async () => { throw new Error('DNS should not have been used for this path'); };
const lookupResolvesTo = (addresses) => async () => addresses;
// A lookupImpl resolving to an ordinary public address, for tests exercising the fetch/parse path
// rather than the SSRF guard itself — real DNS is never used in this test file.
const publicLookup = lookupResolvesTo([{ address: '93.184.216.34', family: 4 }]);

describe('parseDependencyDiffFlag', () => {
  test('unset or false is off', () => {
    assert.equal(parseDependencyDiffFlag(''), false);
    assert.equal(parseDependencyDiffFlag('false'), false);
    assert.equal(parseDependencyDiffFlag('FALSE'), false);
  });

  test('true is on', () => {
    assert.equal(parseDependencyDiffFlag('true'), true);
    assert.equal(parseDependencyDiffFlag(' True '), true);
  });

  test('a garbage value throws, naming the input', () => {
    assert.throws(() => parseDependencyDiffFlag('yes'), /DEPENDENCY_DIFF/);
  });
});

describe('parseGoModBumps', () => {
  test('a removed+added pair for the same module is one bump', () => {
    const patch = [
      '@@ -5,7 +5,7 @@',
      ' require (',
      '-\tgolang.org/x/net v0.53.0',
      '+\tgolang.org/x/net v0.55.0',
      ' )',
    ].join('\n');
    assert.deepEqual(parseGoModBumps(patch), [
      { modulePath: 'golang.org/x/net', from: 'v0.53.0', to: 'v0.55.0' },
    ]);
  });

  test('multiple bumped requirements in one patch each become their own bump', () => {
    const patch = [
      '@@ -5,9 +5,9 @@',
      ' require (',
      '-\tgolang.org/x/net v0.53.0',
      '+\tgolang.org/x/net v0.55.0',
      '-\tgolang.org/x/sys v0.43.0',
      '+\tgolang.org/x/sys v0.46.0',
      ' )',
    ].join('\n');
    const bumps = parseGoModBumps(patch);
    assert.equal(bumps.length, 2);
    assert.deepEqual(bumps.find(b => b.modulePath === 'golang.org/x/net'), { modulePath: 'golang.org/x/net', from: 'v0.53.0', to: 'v0.55.0' });
    assert.deepEqual(bumps.find(b => b.modulePath === 'golang.org/x/sys'), { modulePath: 'golang.org/x/sys', from: 'v0.43.0', to: 'v0.46.0' });
  });

  test('a newly added requirement (no matching removal) is not a bump', () => {
    const patch = '@@ -5,6 +5,7 @@\n require (\n+\tgithub.com/new/module v1.0.0\n )';
    assert.deepEqual(parseGoModBumps(patch), []);
  });

  test('a removed requirement with no replacement is not a bump', () => {
    const patch = '@@ -5,7 +5,6 @@\n require (\n-\tgithub.com/old/module v1.0.0\n )';
    assert.deepEqual(parseGoModBumps(patch), []);
  });

  test('identical version on both sides (a reformat, not a bump) is excluded', () => {
    const patch = '@@ -5,7 +5,7 @@\n-\tgithub.com/pressly/goose/v3 v3.27.1\n+\tgithub.com/pressly/goose/v3 v3.27.1';
    assert.deepEqual(parseGoModBumps(patch), []);
  });

  test('file header lines (+++/---) are not mistaken for requirement lines', () => {
    const patch = '--- a/go.mod\n+++ b/go.mod\n@@ -1,1 +1,1 @@\n-\tgolang.org/x/mod v0.35.0\n+\tgolang.org/x/mod v0.37.0';
    assert.deepEqual(parseGoModBumps(patch), [{ modulePath: 'golang.org/x/mod', from: 'v0.35.0', to: 'v0.37.0' }]);
  });

  test('an empty or missing patch yields no bumps', () => {
    assert.deepEqual(parseGoModBumps(''), []);
    assert.deepEqual(parseGoModBumps(undefined), []);
  });
});

describe('resolveModuleRepo', () => {
  test('a direct github.com module path resolves without any network or DNS call', async () => {
    const repo = await resolveModuleRepo('github.com/pressly/goose/v3', noNetwork, noDns);
    assert.deepEqual(repo, { owner: 'pressly', repo: 'goose' });
  });

  test('a github.com module path with no version suffix resolves the same way', async () => {
    const repo = await resolveModuleRepo('github.com/dolthub/driver', noNetwork, noDns);
    assert.deepEqual(repo, { owner: 'dolthub', repo: 'driver' });
  });

  test('a golang.org/x/* module resolves to its known github mirror without a network or DNS call', async () => {
    assert.deepEqual(await resolveModuleRepo('golang.org/x/net', noNetwork, noDns), { owner: 'golang', repo: 'net' });
    assert.deepEqual(await resolveModuleRepo('golang.org/x/sync', noNetwork, noDns), { owner: 'golang', repo: 'sync' });
  });

  test('an unresolvable module path falls through to vanity-import discovery', async () => {
    const html = '<html><head><meta name="go-import" content="example.com/some/module git https://github.com/someorg/somerepo"></head></html>';
    const fetchImpl = async (url) => {
      assert.equal(url, 'https://example.com/some/module?go-get=1');
      return { ok: true, text: async () => html };
    };
    const repo = await resolveModuleRepo('example.com/some/module', fetchImpl, publicLookup);
    assert.deepEqual(repo, { owner: 'someorg', repo: 'somerepo' });
  });

  test('discovery returning a non-github VCS resolves to null', async () => {
    const html = '<meta name="go-import" content="example.com/some/module git https://gitlab.com/someorg/somerepo">';
    const repo = await resolveModuleRepo('example.com/some/module', async () => ({ ok: true, text: async () => html }), publicLookup);
    assert.equal(repo, null);
  });

  test('a go-import tag for a DIFFERENT module prefix is not matched', async () => {
    const html = '<meta name="go-import" content="example.com/other git https://github.com/someorg/somerepo">';
    const repo = await resolveModuleRepo('example.com/some/module', async () => ({ ok: true, text: async () => html }), publicLookup);
    assert.equal(repo, null);
  });

  test('a non-ok discovery response resolves to null', async () => {
    const repo = await resolveModuleRepo('example.com/some/module', async () => ({ ok: false }), publicLookup);
    assert.equal(repo, null);
  });

  test('a module path smuggling a scheme, credentials, or query/fragment is rejected before any fetch or DNS lookup is attempted', async () => {
    for (const bad of ['https://evil.example/x', 'user@evil.example/x', 'evil.example/x y', 'evil.example/x?redirect=1', 'evil.example/x#frag']) {
      const repo = await resolveModuleRepo(bad, noNetwork, noDns);
      assert.equal(repo, null, bad);
    }
  });

  test('a host resolving to a private/loopback/link-local/metadata address is rejected before the discovery fetch is attempted', async () => {
    const privateAddresses = [
      { address: '10.0.0.5', family: 4 },      // RFC 1918
      { address: '127.0.0.1', family: 4 },     // loopback
      { address: '169.254.169.254', family: 4 }, // link-local — cloud metadata endpoint
      { address: '172.16.0.1', family: 4 },
      { address: '192.168.1.1', family: 4 },
      { address: '::1', family: 6 },           // IPv6 loopback
      { address: 'fe80::1', family: 6 },       // IPv6 link-local
      { address: 'fd00::1', family: 6 },       // IPv6 unique-local
    ];
    for (const addr of privateAddresses) {
      const repo = await resolveModuleRepo('internal-service.example/some/module', noNetwork, lookupResolvesTo([addr]));
      assert.equal(repo, null, JSON.stringify(addr));
    }
  });

  test('an unresolvable hostname is treated as unsafe, not fetched', async () => {
    const flakyLookup = async () => { throw new Error('ENOTFOUND'); };
    const repo = await resolveModuleRepo('nonexistent.example/some/module', noNetwork, flakyLookup);
    assert.equal(repo, null);
  });
});

describe('isPublicAddress', () => {
  test('rejects every RFC 1918 / loopback / link-local IPv4 range', () => {
    for (const addr of ['10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '0.0.0.0']) {
      assert.equal(isPublicAddress(addr, 4), false, addr);
    }
  });

  test('accepts an ordinary public IPv4 address', () => {
    assert.equal(isPublicAddress('140.82.121.3', 4), true); // a real github.com address range
    assert.equal(isPublicAddress('172.15.0.1', 4), true);   // just below the 172.16/12 private range
    assert.equal(isPublicAddress('172.32.0.1', 4), true);   // just above it
  });

  test('rejects IPv6 loopback, link-local, and unique-local addresses', () => {
    for (const addr of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      assert.equal(isPublicAddress(addr, 6), false, addr);
    }
  });

  test('accepts an ordinary public IPv6 address', () => {
    assert.equal(isPublicAddress('2606:4700:4700::1111', 6), true);
  });
});

describe('isSafeHost', () => {
  test('true when every resolved address is public', async () => {
    const lookup = lookupResolvesTo([{ address: '140.82.121.3', family: 4 }, { address: '2606:4700::1', family: 6 }]);
    assert.equal(await isSafeHost('github.com', lookup), true);
  });

  test('false when ANY resolved address is private, even if others are public', async () => {
    const lookup = lookupResolvesTo([{ address: '140.82.121.3', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    assert.equal(await isSafeHost('example.com', lookup), false);
  });

  test('false when resolution throws', async () => {
    const throwingLookup = async () => { throw new Error('ENOTFOUND'); };
    assert.equal(await isSafeHost('example.com', throwingLookup), false);
  });
});

describe('refFor', () => {
  test('a tagged version passes through unchanged', () => {
    assert.equal(refFor('v0.55.0'), 'v0.55.0');
    assert.equal(refFor('v3.27.3'), 'v3.27.3');
  });

  test('a pseudo-version resolves to its embedded commit hash', () => {
    assert.equal(refFor('v0.2.1-0.20260314000741-0fe74e7ee31a'), '0fe74e7ee31a');
  });
});

describe('fetchUpstreamChangeSummary', () => {
  test('a resolved module returns commits/files capped and counted', async () => {
    const commits = Array.from({ length: 35 }, (_, i) => ({ sha: `${i}`.padStart(40, '0'), commit: { message: `commit ${i}\n\nbody` } }));
    const files = Array.from({ length: 60 }, (_, i) => ({ filename: `file${i}.go` }));
    const octokit = {
      rest: { repos: { compareCommits: async ({ owner, repo, base, head }) => {
        assert.equal(owner, 'golang');
        assert.equal(repo, 'net');
        assert.equal(base, 'v0.53.0');
        assert.equal(head, 'v0.55.0');
        return { data: { html_url: 'https://github.com/golang/net/compare/v0.53.0...v0.55.0', commits, files } };
      } } },
    };
    const summary = await fetchUpstreamChangeSummary(octokit, { modulePath: 'golang.org/x/net', from: 'v0.53.0', to: 'v0.55.0' }, noNetwork);
    assert.equal(summary.resolved, true);
    assert.equal(summary.owner, 'golang');
    assert.equal(summary.repoName, 'net');
    assert.equal(summary.totalCommits, 35);
    assert.equal(summary.commits.length, 30);
    assert.equal(summary.totalFiles, 60);
    assert.equal(summary.files.length, 50);
    assert.equal(summary.commits[0].message, 'commit 5'); // most-recent 30 of 35 kept
  });

  test('an unresolvable module reports resolved:false without calling compareCommits', async () => {
    const octokit = { rest: { repos: { compareCommits: async () => { throw new Error('must not be called'); } } } };
    const summary = await fetchUpstreamChangeSummary(octokit, { modulePath: 'gitlab.example/foo/bar', from: 'v1.0.0', to: 'v1.1.0' }, async () => ({ ok: false }), publicLookup);
    assert.equal(summary.resolved, false);
    assert.match(summary.reason, /could not resolve/);
  });

  test('a failed compare call reports resolved:false naming the cause', async () => {
    const octokit = { rest: { repos: { compareCommits: async () => { throw new Error('Not Found'); } } } };
    const summary = await fetchUpstreamChangeSummary(octokit, { modulePath: 'github.com/pressly/goose/v3', from: 'v3.27.1', to: 'v3.27.3' }, noNetwork);
    assert.equal(summary.resolved, false);
    assert.match(summary.reason, /pressly\/goose/);
    assert.match(summary.reason, /Not Found/);
  });

  test('a network error DURING module resolution (not just compareCommits) reports resolved:false and never throws', async () => {
    const octokit = { rest: { repos: { compareCommits: async () => { throw new Error('must not be called — resolution failed first'); } } } };
    const flakyFetch = async () => { throw new Error('ECONNRESET'); };
    const summary = await fetchUpstreamChangeSummary(octokit, { modulePath: 'example.com/some/module', from: 'v1.0.0', to: 'v1.1.0' }, flakyFetch, publicLookup);
    assert.equal(summary.resolved, false);
    assert.match(summary.reason, /could not resolve/);
    assert.match(summary.reason, /ECONNRESET/);
  });
});

describe('renderDependencyDiffNote', () => {
  test('no summaries renders nothing', () => {
    assert.equal(renderDependencyDiffNote([]), '');
    assert.equal(renderDependencyDiffNote(undefined), '');
  });

  test('a resolved summary renders commits, files, and the compare URL', () => {
    const note = renderDependencyDiffNote([{
      modulePath: 'golang.org/x/net', from: 'v0.53.0', to: 'v0.55.0',
      resolved: true, owner: 'golang', repoName: 'net',
      compareUrl: 'https://github.com/golang/net/compare/v0.53.0...v0.55.0',
      totalCommits: 2, commits: [{ sha: 'abc123', message: 'fix thing' }],
      totalFiles: 1, files: ['http2/transport.go'],
    }]);
    assert.match(note, /golang\.org\/x\/net: v0\.53\.0 → v0\.55\.0/);
    assert.match(note, /github\.com\/golang\/net/);
    assert.match(note, /abc123 fix thing/);
    assert.match(note, /http2\/transport\.go/);
    assert.match(note, /READ-ONLY reference material/);
  });

  test('an unresolved summary still renders, naming the reason, without a compare block', () => {
    const note = renderDependencyDiffNote([{
      modulePath: 'gitlab.example/foo/bar', from: 'v1.0.0', to: 'v1.1.0',
      resolved: false, reason: 'could not resolve a GitHub repository for this module path',
    }]);
    assert.match(note, /gitlab\.example\/foo\/bar: v1\.0\.0 → v1\.1\.0/);
    assert.match(note, /Upstream change not fetched/);
  });
});
