# Daemon restart with no desktop session

- Status: done
- Open: not yet run live in user/<uid> (restart, start and install on the Mac with no desktop login)

`flowryn daemon restart` refused `not_supervised`, and `daemon start` launched an unsupervised background daemon, whenever the Mac had no desktop login (only SSH). Every launchctl call addressed `gui/<uid>`, which then does not exist (`125: Domain does not support specified action`), while the agent was loaded in `user/<uid>`.

## The domain

`src/service/launchd.ts` decides it in one place:

- `printAgent` prints the agent in `gui/<uid>` and `user/<uid>` and returns the copy that reports a running pid, else the first loaded copy (or null). The Aqua+Background plist can be loaded in both at once (a background session at boot or over SSH, then a desktop login), so this picks the copy that runs the daemon.
- `bootstrapDomain` is where a bootstrap loads it: `gui/<uid>` while `launchctl print gui/<uid>` succeeds, else `user/<uid>`.
- `launchdDomain(label)` is where every other call addresses it: the loaded domain, else the bootstrap domain.

So an agent loaded in `user/<uid>` is still addressed there after a desktop login returns. `unloadAgent` boots the agent out of every domain it is loaded in and waits until it is gone from all of them before the next bootstrap, so a reinstall or relaunch never leaves a KeepAlive copy behind. `isLoaded`, `agentPid` (the restart's supervision check), `kickstart` (`daemon start`), `loadAgent` (`daemon install`, the start fallback) and the relaunch helper's state and fallback kickstart all go through these.

## The plist

`daemon install` writes `LimitLoadToSessionType` (and `daemon install --print` shows the same plist, through `servicePlist`) = `Aqua`, `Background` when it bootstraps into `user/<uid>`: a plist without it defaults to Aqua, which `user/<uid>` refuses (`134: Service cannot load in requested session`). This is the value the hand-fixed plist had since 2026-11-18. Under a desktop session the key is left out, as before. `plistDrift` does not compare it, so a plist written either way never reads as drift. A bootstrap into `user/<uid>` that fails names the key in its hint.

## Tests

`test/unit/launchd.test.ts` scripts launchctl with and without `gui/<uid>`: the bootstrap domain, an agent loaded in `user/<uid>` while gui exists, `agentPid` and `kickstart` in `user/<uid>`, a reload that boots out of and bootstraps into `user/<uid>`, a copy in each domain (the running one is addressed; `unloadAgent` boots out both), the plist key read back through `plutil -convert json` (macOS only), and the bootstrap hint. `test/unit/relaunch.test.ts` runs the restart's helper in `user/<uid>`, including the fallback kickstart.
