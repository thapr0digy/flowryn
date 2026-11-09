# Verify in under 15 minutes: the parallel runner in this home's verify

- Status: partial
- Open: measurements in progress
- Config: `[projects.flowryn] verify`, `verify_timeout_min`, `[capacity] validation`, `FLOWRYN_TEST_JOBS`

## The recommended verify block

```toml
[projects.flowryn]
verify = [
  "bun install --frozen-lockfile",
  ["bun run typecheck", "npx oxlint", "bun run build"],
  [
    { run = "./dist/flowryn doctor --contracts --verify-only --harness claude", when_changed = ["src/**", "spikes/pi/lib/**", "scripts/build.sh", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json"] },
    { run = "./dist/flowryn doctor --contracts --verify-only --harness pi", when_changed = ["src/**", "spikes/pi/lib/**", "scripts/build.sh", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json"] },
  ],
  "FLOWRYN_TEST_JOBS=6 bun run test:unit",
  "FLOWRYN_TEST_JOBS=6 bun run test:integration",
]
verify_binary = "dist/flowryn"
verify_timeout_min = 30
```
