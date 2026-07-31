'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  parseDependencyDiffFlag,
  parseGoModBumps,
  resolveModuleRepo,
  fetchUpstreamChangeSummary,
  renderDependencyDiffNote,
  renderDependencyReviewSection,
  semverMagnitude,
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

  test('a replace directive is not mistaken for a require bump (its LHS is not the version in effect)', () => {
    const patch = '@@ -1,1 +1,1 @@\n-\tgithub.com/foo/bar v1.2.0 => github.com/foo/bar v1.2.0\n+\tgithub.com/foo/bar v1.2.0 => github.com/foo/bar v1.3.0';
    assert.deepEqual(parseGoModBumps(patch), []);
  });

  test('a genuine require bump on the same patch as a changed replace directive only yields the require bump', () => {
    const patch = [
      '@@ -1,4 +1,4 @@',
      '-\tgolang.org/x/net v0.53.0',
      '+\tgolang.org/x/net v0.55.0',
      '-\tgithub.com/foo/bar v1.2.0 => github.com/foo/bar v1.2.0',
      '+\tgithub.com/foo/bar v1.2.0 => github.com/foo/bar v1.3.0',
    ].join('\n');
    assert.deepEqual(parseGoModBumps(patch), [{ modulePath: 'golang.org/x/net', from: 'v0.53.0', to: 'v0.55.0' }]);
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

  test('an underscore in the domain segment clears the shape check and reaches resolution (Go module paths allow it)', async () => {
    let lookupCalls = 0;
    const lookup = async (hostname) => { lookupCalls++; assert.equal(hostname, 'my_domain.example'); return [{ address: '93.184.216.34', family: 4 }]; };
    const repo = await resolveModuleRepo('my_domain.example/some/pkg', async () => ({ ok: false }), lookup);
    assert.equal(lookupCalls, 1, 'the shape check let this path through to DNS resolution, unlike a truly malformed path');
    assert.equal(repo, null); // ok:false from the stub — resolution itself is not under test here
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

  test('rejects the RFC 6598 shared/CGNAT range (100.64.0.0/10), used by some clouds for internal infra', () => {
    for (const addr of ['100.64.0.1', '100.100.100.1', '100.127.255.255']) {
      assert.equal(isPublicAddress(addr, 4), false, addr);
    }
    // just outside the /10 on either side stays public
    assert.equal(isPublicAddress('100.63.255.255', 4), true);
    assert.equal(isPublicAddress('100.128.0.1', 4), true);
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

  test('a v2+ incompatible module strips the +incompatible suffix to the real git tag', () => {
    assert.equal(refFor('v2.0.0+incompatible'), 'v2.0.0');
    assert.equal(refFor('v3.1.4+incompatible'), 'v3.1.4');
  });

  test('an incompatible pseudo-version strips both the suffix and resolves to the commit hash', () => {
    assert.equal(refFor('v2.0.0-20260101000000-abcdef012345+incompatible'), 'abcdef012345');
  });
});

describe('fetchUpstreamChangeSummary', () => {
  test('a +incompatible version bump resolves against the stripped git tag', async () => {
    const octokit = {
      rest: { repos: { compareCommits: async ({ base, head }) => {
        assert.equal(base, 'v1.9.0');
        assert.equal(head, 'v2.0.0');
        return { data: { html_url: 'https://github.com/dolthub/driver/compare/v1.9.0...v2.0.0', commits: [], files: [] } };
      } } },
    };
    const summary = await fetchUpstreamChangeSummary(octokit, { modulePath: 'github.com/dolthub/driver', from: 'v1.9.0+incompatible', to: 'v2.0.0+incompatible' }, noNetwork);
    assert.equal(summary.resolved, true);
  });

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

  test('a truncated summary (totalCommits/totalFiles exceeding what is shown) surfaces the truncation explicitly', () => {
    const note = renderDependencyDiffNote([{
      modulePath: 'golang.org/x/net', from: 'v0.53.0', to: 'v0.55.0',
      resolved: true, owner: 'golang', repoName: 'net',
      compareUrl: 'https://github.com/golang/net/compare/v0.53.0...v0.55.0',
      totalCommits: 35, commits: Array.from({ length: 30 }, (_, i) => ({ sha: `${i}`, message: `commit ${i}` })),
      totalFiles: 60, files: Array.from({ length: 50 }, (_, i) => `file${i}.go`),
    }]);
    assert.match(note, /35 total, most recent 30 shown/);
    assert.match(note, /60 total, first 50 shown/);
  });

  test('a NON-truncated summary (counts match what is shown) omits the truncation note', () => {
    const note = renderDependencyDiffNote([{
      modulePath: 'golang.org/x/net', from: 'v0.53.0', to: 'v0.55.0',
      resolved: true, owner: 'golang', repoName: 'net',
      compareUrl: 'https://github.com/golang/net/compare/v0.53.0...v0.55.0',
      totalCommits: 2, commits: [{ sha: 'abc123', message: 'fix thing' }, { sha: 'def456', message: 'another' }],
      totalFiles: 1, files: ['http2/transport.go'],
    }]);
    assert.ok(!note.includes('shown'));
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

describe('semverMagnitude', () => {
  test('classifies patch / minor / major by which core component moved', () => {
    assert.equal(semverMagnitude('v1.2.3', 'v1.2.4'), 'patch');
    assert.equal(semverMagnitude('v1.2.3', 'v1.3.0'), 'minor');
    assert.equal(semverMagnitude('v1.2.3', 'v2.0.0'), 'major');
  });

  test('a +incompatible suffix is ignored — only the vX.Y.Z core decides the magnitude', () => {
    assert.equal(semverMagnitude('v2.0.0+incompatible', 'v3.0.0+incompatible'), 'major');
    assert.equal(semverMagnitude('v2.0.0+incompatible', 'v2.1.0+incompatible'), 'minor');
  });

  test('a pseudo-version (untagged commit move) with no semver step is unknown, not a forced label', () => {
    assert.equal(semverMagnitude('v0.0.0-20240101000000-abcdef012345', 'v0.0.0-20240202000000-fedcba543210'), 'unknown');
  });

  test('a non-semver string is unknown rather than a guess', () => {
    assert.equal(semverMagnitude('latest', 'v1.0.0'), 'unknown');
  });
});

// A resolved, assessed summary factory — the common case — so each test varies only what it asserts.
function resolvedSummary(over = {}) {
  return {
    modulePath: 'github.com/gorilla/mux', from: 'v1.7.0', to: 'v1.8.0',
    resolved: true, owner: 'gorilla', repoName: 'mux',
    compareUrl: 'https://github.com/gorilla/mux/compare/v1.7.0...v1.8.0',
    totalCommits: 2, commits: [{ sha: 'abc123def456', message: 'add context support' }],
    totalFiles: 1, files: ['mux.go'],
    ...over,
  };
}
function assessment(over = {}) {
  return { module: 'github.com/gorilla/mux', impact: 'adds request context helpers', affected: false, callSite: null, verdict: 'safe', ...over };
}

describe('renderDependencyReviewSection', () => {
  test('no summaries renders nothing (a non-dependency PR is unchanged)', () => {
    assert.equal(renderDependencyReviewSection([]), '');
    assert.equal(renderDependencyReviewSection(undefined), '');
  });

  test('a resolved+assessed module renders a <details> whose summary carries glyph, module, jump, magnitude, and impact', () => {
    const out = renderDependencyReviewSection([resolvedSummary()], [assessment()]);
    assert.match(out, /<details>/);
    assert.match(out, /<summary>✅ <code>github\.com\/gorilla\/mux<\/code> <code>v1\.7\.0 → v1\.8\.0<\/code> · minor · adds request context helpers<\/summary>/);
  });

  test("the expanded body links compare, commits, and release, and states repo impact + verdict", () => {
    const out = renderDependencyReviewSection([resolvedSummary()], [assessment()]);
    assert.match(out, /\*\*Compare:\*\* \[full comparison\]\(https:\/\/github\.com\/gorilla\/mux\/compare\/v1\.7\.0\.\.\.v1\.8\.0\)/);
    assert.match(out, /\[`abc123def456`\]\(https:\/\/github\.com\/gorilla\/mux\/commit\/abc123def456\) add context support/);
    assert.match(out, /\*\*Release notes:\*\* \[v1\.8\.0\]\(https:\/\/github\.com\/gorilla\/mux\/releases\/tag\/v1\.8\.0\)/);
    assert.match(out, /\*\*Impact on this repo:\*\* Not affected\./);
    assert.match(out, /\*\*Verdict:\*\* ✅ Safe — routine bump; safe to merge\./);
  });

  test('an AFFECTED assessment names the call site in the repo-impact line', () => {
    const out = renderDependencyReviewSection(
      [resolvedSummary()],
      [assessment({ affected: true, callSite: 'internal/router.go:42', verdict: 'risky' })],
    );
    assert.match(out, /🛑 <code>github\.com\/gorilla\/mux<\/code>/);
    assert.match(out, /\*\*Impact on this repo:\*\* Affected — internal\/router\.go:42/);
    assert.match(out, /\*\*Verdict:\*\* 🛑 Risky/);
  });

  test('an affected assessment that failed to name a call site degrades explicitly, never silently', () => {
    const out = renderDependencyReviewSection([resolvedSummary()], [assessment({ affected: true, callSite: null, verdict: 'review' })]);
    assert.match(out, /Affected — \(call site not named\)/);
  });

  test('an unresolved module renders a plain line (no <details> to expand), naming why', () => {
    const out = renderDependencyReviewSection([{
      modulePath: 'gitlab.example/foo/bar', from: 'v1.0.0', to: 'v1.1.0',
      resolved: false, reason: 'could not resolve a GitHub repository for this module path',
    }], []);
    assert.doesNotMatch(out, /<details>/);
    assert.match(out, /⚪ `gitlab\.example\/foo\/bar` `v1\.0\.0 → v1\.1\.0` — upstream not fetched \(could not resolve/);
  });

  test('a resolved module with NO matching assessment still renders host facts, flagged as unassessed', () => {
    const out = renderDependencyReviewSection([resolvedSummary()], []); // no assessments at all
    assert.match(out, /<details>/);
    assert.match(out, /No merge-risk assessment was recorded for this module/);
    assert.match(out, /\*\*Compare:\*\*/); // host facts still present
    assert.match(out, /1 ❔ unassessed/); // reflected in the roll-up, with its own glyph
    // ❔ (fetched-but-unassessed) is distinct from ⚪ (not fetched) in the <summary>.
    assert.match(out, /<summary>❔ /);
  });

  test('a pseudo-version target has no release page, so no release line is emitted', () => {
    const out = renderDependencyReviewSection(
      [resolvedSummary({ to: 'v0.0.0-20240202000000-fedcba543210' })],
      [assessment({ verdict: 'review' })],
    );
    assert.doesNotMatch(out, /Release notes:/);
  });

  test('commit lists are capped in the display, with the remainder pointed at the comparison', () => {
    const commits = Array.from({ length: 25 }, (_, i) => ({ sha: `sha${i}`.padEnd(12, '0'), message: `commit ${i}` }));
    const out = renderDependencyReviewSection([resolvedSummary({ totalCommits: 25, commits })], [assessment()]);
    assert.match(out, /…and 15 more \(see the full comparison\)\./); // 25 total, 10 shown
  });

  test('untrusted content rendered into the HTML body is entity-encoded, not injected (impact + commit message)', () => {
    const out = renderDependencyReviewSection(
      [resolvedSummary({ commits: [{ sha: 'abc123def456', message: '</summary><details open><summary>gotcha' }] })],
      [assessment({ impact: 'breaks </summary></details> the layout', affected: true, callSite: '<img src=x>router.go' })],
    );
    // The raw structural sequences must NOT appear; their encoded forms must.
    assert.doesNotMatch(out, /<summary>gotcha/);
    assert.doesNotMatch(out, /breaks <\/summary>/);
    assert.match(out, /breaks &lt;\/summary&gt;&lt;\/details&gt; the layout/);
    assert.match(out, /&lt;\/summary&gt;&lt;details open&gt;&lt;summary&gt;gotcha/);
    assert.match(out, /&lt;img src=x&gt;router\.go/);
    // Exactly one opening <summary> tag survives (ours) — the injected ones are encoded away.
    assert.equal((out.match(/<summary>/g) || []).length, 1);
  });

  test('markdown metacharacters in an upstream commit message render literally, not as a live link or emphasis', () => {
    const out = renderDependencyReviewSection(
      [resolvedSummary({ commits: [{ sha: 'abc123def456', message: 'see [click](https://evil.example) and **bold**' }] })],
      [assessment()],
    );
    // The link/emphasis syntax is neutralized (backslash-escaped) — no live markdown link or bold survives.
    assert.doesNotMatch(out, /\[click\]\(https:\/\/evil\.example\)/);
    assert.match(out, /\\\[click\\\]\\\(https:\/\/evil\.example\\\)/);
    assert.match(out, /\\\*\\\*bold\\\*\\\*/);
  });

  test('a crafted version string is HTML-escaped in the header and cannot become a release URL', () => {
    const out = renderDependencyReviewSection(
      [resolvedSummary({ to: 'v1.8.0<script>' })],
      [assessment({ verdict: 'review' })],
    );
    assert.doesNotMatch(out, /Release notes:/);       // not a strict tag → no release URL built from it
    assert.doesNotMatch(out, /v1\.8\.0<script>/);     // raw markup never reaches the body
    assert.match(out, /v1\.8\.0&lt;script&gt;/);      // escaped inside the <code> header
    // The compare link text is static, so a `]`/`(` in a version can't break the markdown link either.
    assert.match(out, /\[full comparison\]/);
  });

  test('the roll-up tallies every non-zero bucket across mixed modules', () => {
    const summaries = [
      resolvedSummary({ modulePath: 'github.com/a/one' }),
      resolvedSummary({ modulePath: 'github.com/a/two' }),
      resolvedSummary({ modulePath: 'github.com/a/three' }),
      { modulePath: 'gitlab.example/x/y', from: 'v1.0.0', to: 'v2.0.0', resolved: false, reason: 'no GitHub repo' },
    ];
    const assessments = [
      assessment({ module: 'github.com/a/one', verdict: 'safe' }),
      assessment({ module: 'github.com/a/two', verdict: 'review' }),
      assessment({ module: 'github.com/a/three', verdict: 'risky' }),
    ];
    const out = renderDependencyReviewSection(summaries, assessments);
    assert.match(out, /\*\*Dependency review\*\* — 4 module\(s\): 1 ✅ safe · 1 ⚠️ review · 1 🛑 risky · 1 ⚪ unresolved/);
  });
});
