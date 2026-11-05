# Bun 1.4.4 support, and config tables defined twice

- Status: partial
- Open: the CI bump itself (`.github/workflows/ci.yml` `bun-version: 1.3.8` → `1.4.4`): GitHub refused the push, as the pushing token lacks the `workflow` scope, so it ships separately

CI pins Bun 1.3.8 (the M1 commit's then-current version); the user's Mac runs 1.4.4, and this change makes the code and suite pass on both, ready for CI to move to 1.4.4. On 1.4.4, 13 tests failed on main, all from one parser change: Bun 1.4's TOML follows the spec and refuses a table defined twice (`Bun.TOML.parse("[a]\nx=1\n[a]\ny=2")` throws "Cannot redefine table 'a'"), where 1.3.8 merged the two.

## What 1.3.8 did, and what Flowryn now does

Checked against Bun 1.3.8's own parser (its npm build, run beside 1.4.4): a repeated `[a]` header added its keys to the first `[a]`; a key set under both was still an error ("Cannot redefine key"); `[[x]]` elements and the subtables under them were one per element. A user's `config.toml` that relied on the merge would have stopped loading after a Bun upgrade, and the daemon would refuse to start.

`src/config/toml-parse.ts` keeps that behaviour: `parseTomlText` parses with `Bun.TOML.parse` and, only when the error is "Cannot redefine table", folds each repeated header's lines into the first one (`mergeDuplicateTables`) and parses again. It skips header-like lines inside multi-line strings and in lists or inline tables spread over lines, and never folds tables under an array of tables. A header line whose name it cannot read (a quoted key with an escape, say) makes it fold nothing, so Bun's "Cannot redefine table" error stands rather than keys landing under the wrong table. `parseConfig` and `configOverrides` (the effective-config view) read through it. A key set twice is still refused as `config_invalid`, with Bun's message naming the key. This is plain code, not a model: the merge rule is fixed.

Flowryn's own writers never emit a repeat: `flowryn init` and the contract runner's scratch homes render from one object (`renderToml`), which has one table per name, and nothing appends sections to a `config.toml`.

## Tests

- `test/helpers/harness.ts`: a test home's config is fragments (the harness's own lines, a helper's such as `SHIP_TEST_CONFIG` or `LEADER_TEST_CONFIG`, then a test's own `extraConfig`), so `[leader]` came twice in leader-relay, question-wake and gate-questions. `makeHome` now writes the text through `mergeDuplicateTables`, so every test home has each table once and never leans on the fallback.
- `test/unit/toml-parse.test.ts`: the 1.4 refusal (an assumption test), eight documents read the same as Bun 1.3.8 read them (the expected values are 1.3.8's output), a repeated key still refused, a header it cannot read leaving the refusal in place, unchanged text left alone, a `config.toml` with `[notify]` twice loading with keys from both, and a test home written with each table once.
- `test/unit/verify-steps.test.ts`: the assumption test for a one-line list ending in `]]` now expects Bun 1.4 to read it (1.3 refused it; the sharp edge in `2026-10-22-verify-reliability-per-xe.md` says so).

Both version-dependent assumption tests branch on `Bun.version`, and both files pass on 1.3.8 and 1.4.4.

## The engines floor stays at 1.3.8

`package.json` keeps `engines.bun >= 1.3.8`: nothing in the product needs 1.4 (the duplicate-table reader works on both, and the `]]` list is only something 1.4 additionally accepts). README's setup version is unchanged.
