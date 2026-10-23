# Multiple AI accounts per harness

- Status: partial
- Open: phase 3 (a leader per scope, and moving `~/.flowryn-work` into the main home) is plan p14; `doctor --contracts --account` is not built (contract runs use the implicit Claude account, from `[workers.claude]`); a declared account has not yet run live, and neither has a per-account quota probe against two real logins or Pi's `openai-codex` store
- Config: `[accounts.<id>] harness`, `[accounts.<id>] scope`, `[accounts.<id>] config_dir`, `[accounts.<id>] agent_dir`, `[accounts.<id>] provider`, `[accounts.<id>] model`, `[accounts.<id>] effort`, `[accounts.<id>] overflow`, `[scopes] default`, `[scopes.<id>] paths`, `[scopes.<id>] remotes`, `[scopes.<id>] accounts`, `[projects.<id>] scope`, `[projects.<id>] account`

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

`flowryn accounts` lists each account (harness, scope, login reference, model, effort, open runs, quota, usage pause, overflow). It also lists each project with its scope and the account a new run of it would start on, so the separation can be checked before anything runs.

## Which account a run gets

First match wins:

1. `flowryn dispatch --account <id>` (also on `plan`), or a plan phase's `account: <id>` line. `--harness` without `--account` replaces a stored account.
2. `[projects.<id>] account`, when its harness is the one asked for.
3. The project scope's first account of the harness: the scope's `accounts` order, then the other accounts of the scope in config order. The harness is the one asked for, else the project's.

An account is a harness choice too: `--account chatgpt --harness claude` refuses. A scope with no account for the harness refuses with `no_account`.

**A project's scope** is `[projects.<id>] scope`, else the one `[scopes.*]` whose `paths` (a directory prefix, compared by real path) or `remotes` (a prefix of the repository URL, normalized from `git@host:o/r.git`, `https://host/o/r` or `ssh://…` to `host/o/r` and compared case-insensitively, owner and repository too, as GitHub does) match, else `[scopes] default`. An explicit scope that a rule contradicts refuses, and so does a project two scopes match: a mistyped tag must never quietly win.

The run records its account (`runs.account`, migration 30). A resume or relaunch always uses it, because Claude keeps the session inside the account's own directory. If the account was removed from config, or moved out of the project's scope, the launch refuses. A run recorded on a harness's implicit account (`claude` or `pi`, which migration 30 backfilled for every older run) keeps its `[workers.<harness>]` login after the first `[accounts.*]` of that harness is declared: it resumes on that login in `[scopes] default`, still under the scope rule, and never moves to a declared account. Promoting an ended scout without `--harness` uses its recorded account the same way.

## Without `[accounts]`

Each harness with no declared account gets an implicit account named after the harness (`claude`, `pi`). It is built from `[workers.<harness>]` in `[scopes] default` (itself `default` when unset). A config without accounts therefore resolves and launches as before, and a test checks that the launch plan is identical. Declared accounts inherit `model` and `effort` from `[workers.<harness>]`, but never the login. Harness settings that are not part of a login stay in `[workers.*]`: permission mode, pretrust, Pi extensions and flags, `extra_args`.

## Launching on a login

- **Claude with `config_dir`** (a declared account, or `[workers.claude] config_dir`): the pane gets `CLAUDE_CONFIG_DIR`. The credential variables Claude ranks above a stored login are unset: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and `ANTHROPIC_PROFILE` (the list is `CLAUDE_CREDENTIAL_ENV` in `src/config/accounts.ts`). Without this, an inherited key would silently win over the account.
- **A declared Claude account without `config_dir`** is Claude's default login. `CLAUDE_CONFIG_DIR` is unset as well, so a Herdr server started from inside a work session cannot pass its login on.
- **Unset, not blank.** The design guessed that Claude treats an empty `CLAUDE_CONFIG_DIR` as unset. The build showed it does not: Claude 2.1.x reports `configDirectory ""` and `projectsDirectory "projects"` (a relative path). Herdr's `workspace.create` can only set values, so the launch puts the names in `FLOWRYN_UNSET`. The harness shim (`<state_dir>/shims/<harness>`, already first on the pane's PATH) unsets them before it execs the harness. It skips anything that is not a variable name.
- **Pi**: the pane gets the account's `PI_CODING_AGENT_DIR` (Pi's own `~/.pi/agent` made explicit), and Pi gets `--provider <provider> --model <provider>/<id>`. An agent directory can hold several providers' logins, so the account names the one it spends.
- Claude's contract revision is now 2, because the launch environment and the shim changed. Pi's revision is unchanged: its launch differs only for a declared account, and its suite runs the scripted provider, never a provider login.

## Sign-in check

At every launch grant (a new run's first launch, a resume, a fresh stage, a relaunch), a declared account's login is checked with the harness's own command. The command runs in an environment holding only HOME, PATH, TMPDIR, USER, LOGNAME and the account's directory, so a credential in the daemon's environment cannot answer for an empty login:

- Claude: `claude auth status --json`; signed in when it exits 0 and prints `"loggedIn": true`.
- Pi: `pi auth check --provider <p> --json --no-refresh` (no `--credentials`, so no secret is printed); `"status": "ready"` passes. An extension-registered provider is unknown to `auth check` (`provider_not_found`), so `pi --list-models <p>` decides: a row whose first column is the provider passes.

A signed-out account's runs wait for the grant instead of refusing at dispatch (phase 2): one P1 per account (`account_signed_out`, keyed `account:<id>`) names the command that signs it in, and a passing check resolves it and lets the runs start. A pass is remembered for 5 minutes; a failure is asked again once per scheduler pass. Implicit accounts are never checked, as before. Measured: `claude auth status` takes about 0.3 s.

## Choices made in the build

- Contract runs keep using the implicit Claude account. The scratch config copies `[workers]` and not `[accounts]`, and a contract proves the harness, not a login. `doctor --contracts --account` is left for later.
- A Pi account requires `provider` and a `<provider>/<id>` model, as the predecessor did. Flowryn never guesses a provider.
- The `account:` line on a plan phase is stored in `plan_phases.account`, and the phase takes that account's own harness unless it also has a `harness:` line. A phase without one is resolved when it starts, so a scope's default account can change before then. Every phase's account is checked when the plan is filed, by `flowryn plan` and for a worker's plan at its design's stage done.
- `flowryn accounts` shows no sign-in state. That would run every harness on every read; the scheduler checks the account a launch actually uses.

## Capacity per account (phase 2)

The quota floor and the usage-limit pause used to cover the whole home: one quota-axi reading, and one Claude `rate_limit` paused every Claude run. Each account now has its own (design reviewed at gate g182):

- **The quota floor.** Before a new run starts on an account, the scheduler reads quota-axi for that account's login (cached `[sched] quota_cache_ms` per account). A Claude account's probe has `CLAUDE_CONFIG_DIR` set to its `config_dir`, or deleted for a declared account on Claude's default login, with the credential variables in `CLAUDE_CREDENTIAL_ENV` removed; the implicit `claude` account is read as before (the daemon's environment, plus `[workers.claude] config_dir`). A Pi account is read only for the providers whose Pi store quota-axi 0.1.37 reads: `openai-codex` (`--provider codex`), `kimi-coding` (`kimi`) and `xai` (`grok`), with `PI_CODING_AGENT_DIR` set, `CODEX_HOME` pointed at an empty directory for codex, and `--full` so the report names its source: a reading whose `source` is not `pi:<provider>` is someone else's login and counts as unknown. Any other Pi provider, and the implicit `pi` account, read "unknown", which holds nothing. The floor holds any account with a known reading under it.
- **The usage pause.** A worker's StopFailure `rate_limit` pauses its run's account (`runs.account`; an older run's implicit one), and only that account's launches and stage starts wait; its normal Stop or `quota_auto_resume_fired` lifts it, and the one probe after expiry is per account. A leader's signal belongs to the Claude account whose directory holds the leader's transcript (`<config dir>/projects/`), else the default Claude account.
- **State.** meta `quota:<account>` and `usage_limit:<account>`; their P1s (`quota_low`, `usage_limit`) are keyed `account:<id>`. Events carry `account`. At scheduler start the old `claude_quota` and `claude_usage_limit`, and their unkeyed P1s, move to the default Claude account with one `sched.capacity_moved` event. The default Claude account is what a Claude run of a project in `[scopes] default` starts on; without `[accounts]` it is the implicit `claude`, so a home without accounts keeps the same behaviour under new keys.
- **`flowryn capacity resume --account <id>`** lifts that account's pause and overrides its low quota; `--harness <claude|pi>` does it for every account of the harness. Exactly one is required. `flowryn capacity` lists the pause and the quota per account, and each waiting run's reason names its account.
- **Overflow** (`[accounts.<id>] overflow = ["<id>", …]`, opt-in): while the account is held by its usage pause or its quota floor, a run's first launch (`pending_launch = fresh`, granted by the scheduler) moves to the first listed account that is not paused at all, whose quota is not low and that is signed in. The run takes that account's model and effort, and a `sched.overflow` event records `from`, `to` and `why`. A plan phase that is ready on a held account starts on an overflow account the same way. A resume, relaunch or fresh-stage worker never moves: its session lives in its account's store. Overflow is one level (a target's own list is not followed) and never fires on a signed-out account (signing in is the fix). Config load refuses a target in another scope or of another harness (the user chose same harness only), an unknown one, the account itself, or one listed twice.
- **Doctor** has one `quota probe <id>` row per account quota-axi can read. Auto contract checks wait on the implicit account of their harness, the login a contract run uses.

Choices made in the build:

- The design said the Claude probe would get the sign-in check's minimal environment. The build kept the daemon's environment instead, with `CLAUDE_CONFIG_DIR` set or deleted and the credential variables removed, as the task asked: that is what quota-axi needs to reach the macOS keychain, and the stand-in quota-axi in the test homes reads `$FLOWRYN_HOME`.
- No SQL migration: the default Claude account depends on config, so the move runs in code at scheduler start, and a state the account already has wins over the legacy one.
- `flowryn accounts` shows the reading the quota state last flipped on, with its time (`ok 80% at 12:01`), not a live percent: a live percent would be a database write and an event per probe.
- Claude's contract revision is unchanged: the worker launch path did not change.

## Tests

- `test/unit/accounts.test.ts`: parsing and refusals, scope rules (path prefix, remote forms, contradiction, ambiguity), the resolution order, the scope guard with no override, resume on the recorded account, launch env per account, the shim unsetting names (the assumption that was wrong), the sign-in check ignoring an inherited key, Pi's fallback, and the `account:` plan line.
- `test/unit/db.test.ts`: migration 30 backfills `runs.account` with the harness.
- `test/integration/accounts.test.ts`: through the real CLI and daemon with a fake Herdr. A work project dispatches onto the work login with the credentials unset in its pane; `--account` and a plan phase onto the personal account refuse; a signed-out account's run waits with a P1 naming its login command and starts once it is signed in; a usage limit on one account holds only its runs; a low quota moves a fresh launch, and a ready plan phase, to the overflow account; `flowryn accounts` shows the project's scope and account, and each account's quota.
- `test/unit/account-capacity.test.ts` (phase 2): through the real scheduler, a low quota or a usage pause on one account holds only its runs; overflow moves a fresh launch only when configured, never a resume, and not onto a held or signed-out target; a signed-out account's runs wait with one P1 until it signs in; the legacy state moves to the default Claude account; config refuses an overflow out of scope or harness; a leader's transcript names its account; and the probe's assumptions: it sets or deletes `CLAUDE_CONFIG_DIR` per account, and reads Pi's `openai-codex` login only with `--full`, an empty `CODEX_HOME` and a `pi:openai-codex` source.
- Live, 2026-10-22: `doctor --contracts --verify-only` passed Claude 2.1.308 (revision 2, through the new shim) and Pi 0.87.1. The full `bun test` run under a load average of about 20 (parallel ships) had timing failures in files this change does not touch (external-ops, operations, capacity, drop, turn-end-guard). Run again on their own, they passed, apart from one 300 ms budget in external-ops, which then passed twice.
