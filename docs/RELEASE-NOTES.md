# Open-source preparation

Prepared November 8, 2026 from the supplied hackathon source archive.

- Added a new contributor-oriented README, MIT license, and contribution guide.
- Added the MDC 2026 SharkByte first-place credit supplied by the project owner.
- Added the missing Anthropic API key placeholder and expanded generated-file ignores.
- Removed the checked-in TypeScript build cache.

## Validation

- `npm ci`: passed.
- `npm test`: 737 passed, 3 skipped (68 test files passed, 1 skipped).
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run build:remote`: passed.
- A targeted source scan found no credential-shaped values requiring removal; this is not a comprehensive security audit.
- Desktop runtime, live cloud providers, Python vision tests, and physical printer operation were not validated.

## Dependency audit

The existing dependency versions report 6 npm advisories: 3 moderate, 1 high, and 2 critical. Affected packages are esbuild, vite, vitest, @vitest/mocker, vite-node, and tinypool. npm's proposed fixes require dependency upgrades, including major versions. Those upgrades have not been applied as part of documentation and source-release preparation. Review the current `npm audit` output before deploying development tooling or exposing a development server.
