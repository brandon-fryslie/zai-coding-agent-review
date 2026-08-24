# Contributing

Thank you for your interest in contributing!

## Issues and pull requests

If you have suggestions for improvements, you can contribute by opening an issue. If you'd like to introduce changes to the project, see the instructions below.

## Project structure

```
src/              # Action source, split into focused modules
src/index.js      # Thin entry point — bundles to dist/index.js
src/engine/       # One adapter per engine (claude-code, codex, opencode)
test/             # node:test suite
dist/index.js     # Compiled bundle (used by the runner)
action.yml        # Action metadata and input definitions
```

The action runs from `dist/index.js`, which is a self-contained bundle built from `src/index.js` using [`@vercel/ncc`](https://github.com/vercel/ncc). `src/index.js` only selects the entry point and re-exports for tests — the code you are likely to change lives in the sibling modules.

## Development setup

**Prerequisites:** Node.js 24+ (matches the action runtime — `action.yml` `using: "node24"` and `package.json` `engines.node`)

```bash
git clone https://github.com/promptctl/copirate-code-review-agent.git
cd copirate-code-review-agent
npm install
```

## Making changes

Edit the relevant module under `src/`, then run the tests and rebuild the bundle:

```bash
npm test
npm run build
```

**The `dist/` directory must be committed.** The GitHub Actions runner executes `dist/index.js` directly — it does not run `npm install` or build steps.

## Submitting a pull request

1. Fork the repository and create a branch from `main`
2. Make your changes under `src/`
3. Run `npm test`, then `npm run build`, and commit both `src/` and `dist/` changes
4. Bump `package.json`'s version if the change touches what consumers run (see [Releases](#releases))
5. Open a pull request against `main`

Please keep PRs focused — one fix or feature per PR.

## Releases

Releases are git tags with no `v` prefix — the format is `1.19.0`, never `v1.19.0`. Most consumers pin the moving `@v1` tag, which always points at the latest release.

**A PR that changes what consumers run bumps `package.json`'s version in that same PR**, with `dist/` rebuilt and committed alongside it. Merging to `main` then publishes that version on its own: `.github/workflows/release.yml` runs `scripts/release.sh`. No maintainer tags anything by hand, and a merge that bumped nothing is a clean no-op.

Pick the level by what the change does to the consumer contract, not by whether it is a fix or a feature — under that rule a bug fix whose observable behavior changes is a **minor**, not a patch. [CLAUDE.md](CLAUDE.md)'s "Cutting a release" section is the authority here and gives the level rule in full; this section does not restate it, so the two cannot drift apart.

Users reference the action by tag in their workflows, so the `dist/index.js` and `action.yml` at the tagged commit are what gets executed.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
