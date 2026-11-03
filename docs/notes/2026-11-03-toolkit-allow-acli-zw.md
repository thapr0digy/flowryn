# Toolkit: allow acli jira again

- Status: done

Asked for by the user on 2026-11-03: jira-axi does not support every option they need, so agents must be able to fall back to Atlassian's own CLI.

What changed:

- The toolkit's jira rule (`src/policy/toolkit.ts`) no longer denies `acli jira …`. It still denies argv0 `jira` and `jira-cli`, raw HTTP clients to `*.atlassian.net` or a jira host's `/rest/api` and `/rest/agile`, the Atlassian MCP tools and the `atlassian:` skills: those routes bypass both tools, and acli covers jira-axi's gaps.
- The static Claude layer (`src/policy/static.ts`) drops `Bash(acli jira *)` from its Bash backstops, so worker and leader settings agree with the hook.
- The tool map every worker and leader reads, and the jira deny reason, say: "Jira: jira-axi; for an option jira-axi lacks, acli jira." jira-axi stays the first choice; nothing enforces the order.

Reaching existing installs: worker settings are written at each launch and the leader's on each `flowryn lead` (`writeLeaderFiles`, write-if-changed), so nothing migrates. A leader session already running keeps the old deny until it restarts. Doctor does not pin the static deny list, so it is unchanged.

No `CONTRACT_REVISIONS` bump: the contract suite's toolkit step proves the `gh` deny and the static MCP hide, nothing about jira.

Tests: `test/unit/toolkit.test.ts` (acli jira allowed, `jira`/`jira-cli` denied, the new reason), `test/unit/static-layers.test.ts` (the backstop no longer catches acli jira), and `test/integration/toolkit.test.ts` (acli jira passes the real pre-tool hook; `jira issue list` is denied there).
