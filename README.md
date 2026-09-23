# Flowryn

Flowryn is a self-contained coordinator for a fleet of coding agents. You talk to one leader agent (Claude Code or Pi), and it dispatches workers into isolated worktrees in Herdr panes. Workers push their updates to a single daemon, `flowrynd`, which keeps runtime state in SQLite, ranks each update, and delivers it to the leader at a natural pause so your main conversation is not flooded or interrupted.

## Status

Pre-M0: design only. The architecture spec is [`docs/design-v3.html`](docs/design-v3.html); open it in a browser.

## Key choices

- The control plane is CLI-first: an agent-ergonomic `flowryn` CLI over the daemon socket. An MCP wrapper is optional.
- Runtime state lives in SQLite, owned by `flowrynd`. Tasks and to-dos live in tasks-axi, whose location is set during setup.
- Claude Code and Pi are first-class leaders, and Herdr is the runtime.
