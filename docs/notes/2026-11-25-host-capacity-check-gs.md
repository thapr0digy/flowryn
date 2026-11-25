# Host check reads swap and the Docker VM's CPU pressure

- Status: done
- Open: not yet run under a real swap squeeze (the limits come from the 2026-11-24 measurements below)
- Config: `[capacity.host] pressure`

F3 of the gate speed-up scout (speed-up-signal-a3). On 2026-11-24 the host was 22 of 24 GB used with a 9.85 GB compressor and 15.0 of 16.4 GB swap used, 32% of CPU in the kernel, while the free-memory check said memory was fine. The Colima `default` VM (8 vCPUs) reported CPU pressure "some" avg300 21.5% at load 11.8, and verify timeouts fired when two DB-heavy steps overlapped. The host check (`src/sched/host.ts`, the one that holds every new worker, stage and verify start) now also holds on both.

## What holds

| Reading | Read with | Holds over | Releases under | Never holds when |
|---|---|---|---|---|
| Host swap, used / total | `/usr/sbin/sysctl -n vm.swapusage` (macOS) | 90% | 85% | under 4 GB used: macOS grows swap a 1 GB file at a time, so a small swap is often nearly full on a healthy host |
| Docker VM CPU pressure, "some" avg60 | `colima ssh -- cat /proc/pressure/cpu` (the `default` profile, colima from PATH) | 30% | 20% | the read fails, colima is absent or the VM is stopped |

- **Hysteresis.** A reading between the two levels keeps its last state: the scheduler passes its last verdict (with its `holds`) to the next check. This answers learning l72, where a threshold that flapped at its line blocked verify starts for about 7 h. Memory and load keep their single limits.
- **Why these numbers.** One DB-heavy step alone read avg60 25 to 28% at VM load 9.6 on 8 vCPUs (2026-11-25), so 30% holds only beyond one step's own pressure. Swap at 90% of a large swap is the state measured above, with nothing left to grow into before macOS starts killing apps.
- **Cost.** `sysctl` runs on every check (a few ms). `colima ssh` takes about 0.4 s, so one VM reading serves the checks for 30 s (`VM_READ_MS`); avg60 moves slowly anyway. Both go through `runBounded` with a 5 s deadline, as `vm_stat` and the probe now do too.
- **A failed read holds nothing.** It is named in the verdict's `notes`; the daemon logs `sched: host check reads unknown, not holding: …` once when that changes, and `flowryn doctor` shows it on its host check line.
- **CPU pressure counts as load.** A verify that went red while the VM's pressure held is judged `load`, like one under host load (`src/verify/batch-retry.ts` `envCause`). Swap does not.

## What you see

`flowryn capacity`'s host line names the hold and the needs, for example:

```
host: blocked: swap 91% used (15.0 of 16.4 GB), over 90% (since 2m ago; needs 8 GB free, load per core under 1.5, swap under 90% used, Docker VM CPU pressure under 30%)
```

The line shows the reason recorded when that hold began, still naming swap or Docker VM CPU pressure. The recorded host state changes only when the check flips or the set of holds changes (load to swap, say), so the line never names a cause that has cleared. While a hold stays inside its band it keeps the reading from when it began: swap falling from 92% to 87% still shows `swap 92% used ..., over 90%` until it drops under 85% and the check passes. A run's wait explanation gives the same needs.

## Config

Fixed limits, not keys: they are rules about the host, not preferences, and every new key is one more thing to tune wrongly. The one key is an off switch, because some homes must not be held by them:

- `[capacity.host] pressure = false` turns both readings off. The contract runner's scratch home sets it (its worker runs no Docker, and a busy fleet's swap must not stall the suite), and so do test homes (`test/helpers/harness.ts`), so no test reads this machine's swap or a real Colima.
- A `[capacity.host] probe` replaces every reading. It may print `swap_used_gb`, `swap_total_gb` and `vm_cpu_some_avg60` beside `free_mem_gb` and `load_per_core`; any it leaves out hold nothing.

## Tests

`test/unit/host-check.test.ts`: the swapusage and PSI parsers; swap over the limit holds; inside the band it keeps its last state, both ways; a small full swap and `pressure = false` hold nothing; VM pressure over the limit holds and one step's 28% does not; a failed, absent or garbled VM read passes with a note; one VM read is reused for `VM_READ_MS` (a stand-in colima records its argv); a probe's optional fields; `checkHost` carries the last holds. `test/unit/explanations.test.ts`: the scheduler records the host state when the holds change and passes each check its last verdict. `test/unit/batch-retry.test.ts`: VM pressure is a `load` cause, swap is not.
