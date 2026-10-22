# Multiple AI accounts per harness

- Status: partial
- Open: phase 2 (per-account quota floor and usage pause, opt-in overflow, signed-out accounts wait instead of refusing) and phase 3 (a leader per scope, and moving `~/.flowryn-work` into the main home) are plan p14; `doctor --contracts --account` is not built (contract runs use the implicit Claude account, from `[workers.claude]`); a declared account has not yet run live
- Config: `[accounts.<id>] harness`, `[accounts.<id>] scope`, `[accounts.<id>] config_dir`, `[accounts.<id>] agent_dir`, `[accounts.<id>] provider`, `[accounts.<id>] model`, `[accounts.<id>] effort`, `[scopes] default`, `[scopes.<id>] paths`, `[scopes.<id>] remotes`, `[scopes.<id>] accounts`, `[projects.<id>] scope`, `[projects.<id>] account`

Before this, a Flowryn home had one Claude login and one Pi login for workers (`[workers.claude]`, `[workers.pi]`). Work repositories needed a whole second home (`FLOWRYN_HOME=~/.flowryn-work`, its Claude login in `~/.claude-work`). Now one home can hold several logins, and a rule keeps work and personal apart. The design was reviewed at gate g159. The user chose a leader per scope for phase 3.

## The model

- An **account** is one named login for one harness: where the login lives (Claude's `CLAUDE_CONFIG_DIR`, Pi's `PI_CODING_AGENT_DIR` plus the provider it spends) and its default model and effort.
- Every account and every project belongs to a **scope**, such as `work` or `personal`.
- **The rule:** a run starts only on an account of its project's scope. Dispatch checks it, a plan phase checks it when filed and when it starts, and the launcher checks it again at every launch, resume and relaunch. Nothing overrides it, and a refusal is `account_scope_mismatch` (exit 2).
- Flowryn keeps only references: account ids and directory paths. The login stays in the harness's own store. Nothing is sent anywhere new.

```toml
[scopes]
default = "personal"

[scopes.work]
paths   = ["~/work/"]                 # checkouts under here are work
remotes = ["github.com/acme/"]        # and so are repositories under this remote prefix
accounts = ["claude-work"]            # this scope's account order: the first of a harness is its default

[accounts.claude-work]
harness = "claude"
scope = "work"
config_dir = "~/.claude-work"
model = "opus"

[accounts.claude-personal]
harness = "claude"
scope = "personal"                    # no config_dir: Claude's default login (CLAUDE_CONFIG_DIR unset)

[accounts.chatgpt]                    # a ChatGPT subscription, through Pi's openai-codex provider
harness = "pi"
scope = "personal"
provider = "openai-codex"
model = "openai-codex/gpt-5-codex"    # must be <provider>/<id>
# agent_dir defaults to ~/.pi/agent
```

`flowryn accounts` lists each account (harness, scope, login reference, model, effort, open runs). It also lists each project with its scope and the account a new run of it would start on, so the separation can be checked before anything runs.

## Which account a run gets

First match wins:

1. `flowryn dispatch --account <id>` (also on `plan`), or a plan phase's `account: <id>` line. `--harness` without `--account` replaces a stored account.
2. `[projects.<id>] account`, when its harness is the one asked for.
3. The project scope's first account of the harness: the scope's `accounts` order, then the other accounts of the scope in config order. The harness is the one asked for, else the project's.

An account is a harness choice too: `--account chatgpt --harness claude` refuses. A scope with no account for the harness refuses with `no_account`.

**A project's scope** is `[projects.<id>] scope`, else the one `[scopes.*]` whose `paths` (a directory prefix, compared by real path) or `remotes` (a prefix of the repository URL, normalized from `git@host:o/r.git`, `https://host/o/r` or `ssh://…` to `host/o/r`) match, else `[scopes] default`. An explicit scope that a rule contradicts refuses, and so does a project two scopes match: a mistyped tag must never quietly win.

The run records its account (`runs.account`, migration 28). A resume or relaunch always uses it, because Claude keeps the session inside the account's own directory. If the account was removed from config, or moved out of the project's scope, the launch refuses.

## Without `[accounts]`

Each harness with no declared account gets an implicit account named after the harness (`claude`, `pi`). It is built from `[workers.<harness>]` in `[scopes] default` (itself `default` when unset). A config without accounts therefore resolves and launches as before, and a test checks that the launch plan is identical. Declared accounts inherit `model` and `effort` from `[workers.<harness>]`, but never the login. Harness settings that are not part of a login stay in `[workers.*]`: permission mode, pretrust, Pi extensions and flags, `extra_args`.

## Launching on a login

- **Claude with `config_dir`** (a declared account, or `[workers.claude] config_dir`): the pane gets `CLAUDE_CONFIG_DIR`. The credential variables Claude ranks above a stored login are unset: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and `ANTHROPIC_PROFILE` (the list is `CLAUDE_CREDENTIAL_ENV` in `src/config/accounts.ts`). Without this, an inherited key would silently win over the account.
- **A declared Claude account without `config_dir`** is Claude's default login. `CLAUDE_CONFIG_DIR` is unset as well, so a Herdr server started from inside a work session cannot pass its login on.
- **Unset, not blank.** The design guessed that Claude treats an empty `CLAUDE_CONFIG_DIR` as unset. The build showed it does not: Claude 2.1.x reports `configDirectory ""` and `projectsDirectory "projects"` (a relative path). Herdr's `workspace.create` can only set values, so the launch puts the names in `FLOWRYN_UNSET`. The harness shim (`<state_dir>/shims/<harness>`, already first on the pane's PATH) unsets them before it execs the harness. It skips anything that is not a variable name.
- **Pi**: the pane gets the account's `PI_CODING_AGENT_DIR` (Pi's own `~/.pi/agent` made explicit), and Pi gets `--provider <provider> --model <provider>/<id>`. An agent directory can hold several providers' logins, so the account names the one it spends.
- Claude's contract revision is now 2, because the launch environment and the shim changed. Pi's revision is unchanged: its launch differs only for a declared account, and its suite runs the scripted provider, never a provider login.

## Sign-in check

At dispatch, and when a plan phase or a promoted scout starts, a declared account's login is checked with the harness's own command. The command runs in an environment holding only HOME, PATH, TMPDIR, USER, LOGNAME and the account's directory, so a credential in the daemon's environment cannot answer for an empty login:

- Claude: `claude auth status --json`; signed in when it exits 0 and prints `"loggedIn": true`.
- Pi: `pi auth check --provider <p> --json --no-refresh` (no `--credentials`, so no secret is printed); `"status": "ready"` passes. An extension-registered provider is unknown to `auth check` (`provider_not_found`), so `pi --list-models <p>` decides: a row whose first column is the provider passes.

A signed-out account refuses the dispatch with `account_signed_out` (exit 69) and the command that signs it in. A pass is remembered for 5 minutes; a failure is not. Implicit accounts are never checked, as before. Measured: `claude auth status` takes about 0.3 s.

## Choices made in the build

- Contract runs keep using the implicit Claude account. The scratch config copies `[workers]` and not `[accounts]`, and a contract proves the harness, not a login. `doctor --contracts --account` is left for later.
- A Pi account requires `provider` and a `<provider>/<id>` model, as the predecessor did. Flowryn never guesses a provider.
- The `account:` line on a plan phase is stored in `plan_phases.account`. A phase without one is resolved when it starts, so a scope's default account can change before then.
- `flowryn accounts` shows no sign-in state. That would run every harness on every read; dispatch checks the account it actually uses.

## Tests

- `test/unit/accounts.test.ts`: parsing and refusals, scope rules (path prefix, remote forms, contradiction, ambiguity), the resolution order, the scope guard with no override, resume on the recorded account, launch env per account, the shim unsetting names (the assumption that was wrong), the sign-in check ignoring an inherited key, Pi's fallback, and the `account:` plan line.
- `test/unit/db.test.ts`: migration 28 backfills `runs.account` with the harness.
- `test/integration/accounts.test.ts`: through the real CLI and daemon with a fake Herdr. A work project dispatches onto the work login with the credentials unset in its pane; `--account` and a plan phase onto the personal account refuse; a signed-out account refuses with its login command; `flowryn accounts` shows the project's scope and account.
- Live, 2026-10-22: `doctor --contracts --verify-only` passed Claude 2.1.308 (revision 2, through the new shim) and Pi 0.87.1. The full `bun test` run under a load average of about 20 (parallel ships) had timing failures in files this change does not touch (external-ops, operations, capacity, drop, turn-end-guard). Run again on their own, they passed, apart from one 300 ms budget in external-ops, which then passed twice.
