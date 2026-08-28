# CI gate handoff — the verification gate Phase 01 asked for

Phase 01 closed **PARTIALLY READY** with one follow-up ranked above all the others: put
`npm run verify` in CI, with a hard timeout. The reason was specific. Two of that phase's six
findings were not defects in the platform but in the apparatus — no complete `npm test` had ever
finished, and `npm run verify` had never once been green — and both stayed invisible for the same
reason: the failure mode was a **hang**, and a hang looks like a slow build rather than a red one.

This document records the gate built to answer that, and is honest about the one thing it cannot
yet claim.

---

## 1. Verdict

**CI GATE PARTIALLY READY.** The workflow is written, its logic is proven locally against a real
251-test run, and every assertion in it has been watched fail on a deliberately broken log. It has
never executed on a GitHub runner, because **this repository has no git remote** — so no push or
pull request has ever been able to trigger it.

| Claim                                               | Status                                                    |
| --------------------------------------------------- | --------------------------------------------------------- |
| Workflow exists and parses                          | ✅ `.github/workflows/verify.yml`                         |
| Runs `npm ci`, `npm run verify`, `npm run demo`     | ✅                                                        |
| Hard 15-minute wall-clock ceiling on the job        | ✅ `timeout-minutes: 15`                                  |
| A hang fails by timeout rather than passing         | ✅ by construction, and the log survives the cancellation |
| PostgreSQL suites cannot be skipped without failing | ✅ proven against six synthetic log shapes                |
| Commands proven locally on the committed tree       | ✅ 251 pass, 0 fail, 0 skipped                            |
| Gate observed green on a GitHub-hosted runner       | ❌ **never run — no remote configured**                   |

---

## 2. Workflow file created

`.github/workflows/verify.yml` — one file, one job, no new dependencies, no scripts added to
`package.json`. Nothing else in the repository changed.

## 3. Triggers

```yaml
on:
  push:
    branches: ['**']
  pull_request:
```

Every branch, plus every pull request. Tags are deliberately excluded: with a `branches` filter
present, a tag push does not match, so cutting a release does not re-run the same gate a second
time on the same commit.

A `concurrency` group keyed on `github.ref` with `cancel-in-progress: true` means a superseded push
stops rather than queues. Note that a push and a pull request on the same branch have different
refs, so an internal PR branch still runs the gate twice — once per event. That is the standard
cost of taking the "push **and** pull request" requirement literally, and it is cheap here.

## 4. Node version

`node-version: '24'` — the latest 24.x on the runner.

`package.json` declares `engines.node: ">=24.0.0"`, and the repository depends on Node 24's native
TypeScript execution: there is no build step, and `node --test "tests/**/*.test.ts"` runs `.ts`
files directly. Phase 00 and Phase 01 were both proved on 24.16.0.

The version is pinned in the workflow rather than read from `engines` via `node-version-file`,
because `>=24.0.0` is a range: resolving it would silently move the gate to Node 25 the day it
ships, which is exactly the kind of drift a verification gate is supposed to make impossible.

## 5. Timeout

| Scope                 | Ceiling | Why                                                                                 |
| --------------------- | ------- | ----------------------------------------------------------------------------------- |
| Job                   | 15 min  | The required hard wall-clock ceiling. Kills the whole runner process tree.          |
| `npm run verify` step | 10 min  | So a hang is attributed to the step that hung, not to an arbitrary point in the job |
| `npm run demo` step   | 2 min   | The demo is in-memory and finishes in seconds                                       |

The step ceilings sit deliberately below the job ceiling, leaving roughly three minutes for
checkout, `setup-node` and `npm ci`. Raise the step and the job together or not at all — a step
ceiling above the job ceiling is a step ceiling that never fires.

**A hang cannot appear successful.** GitHub terminates a step that exceeds `timeout-minutes` and
fails the job; there is no path by which an unterminated test process reports success. The
Phase 01 defect — every assertion passing, then the process never exiting because the embedded
server's child handle kept the event loop alive — would surface here as a red job at the 10-minute
mark, with the partial log preserved as an artifact.

## 6. Commands

| Step                | Command                                                           |
| ------------------- | ----------------------------------------------------------------- |
| Install             | `npm ci`                                                          |
| Preflight           | `initdb --version`, `postgres --version` on the bundled binaries  |
| Verify              | `npm run verify` → `format:check` → `lint` → `typecheck` → `test` |
| Assert              | parses the captured log; see §7                                   |
| Demo                | `npm run demo`, then asserts the run reported itself simulated    |
| Stray-cluster check | `pgrep -af 'all-in-moderation-pg-'` must find nothing             |

`npm ci`, never `npm install`: the lockfile is the record of what was proved. Install scripts must
run — see §8.

The demo step does not merely run the demo; it greps for
`All outbound actions are SIMULATED.` in the output. Phase 01's standing constraint is that nothing
in this repository may contact a network, and a gate that only checks the exit code would not
notice the day that stopped being true.

## 7. Do the PostgreSQL tests actually run in CI?

**By construction, yes — the job cannot go green without them. By observation, not yet** (§1).

Three independent assertions run against the captured log after `npm run verify` succeeds:

1. **`fail 0`**, and **`skipped 0`** — catches `it.skip` and a failing test.
2. **`pass >= 251`** — the floor. 147 in-memory + 104 PostgreSQL, as Phase 01 closed. A floor
   rather than an equality so that adding a test does not break the build, and can never shrink
   silently.
3. **All thirteen PostgreSQL suites appear as suites that _ran_** — each named individually in the
   workflow, so no single one can disappear quietly: migrations, row-level security, transactions,
   concurrency, duplicate ingest and bursts, ownership compare-and-swap, durability and failure
   injection, knowledge validity, multi-process workers, security posture, performance sanity,
   vertical slice, and the `JobQueue` contract on Postgres.

### Why the counters alone were not enough

Building this turned up something worth recording. The obvious guard — assert `skipped 0` — does
**not** catch a skipped suite. `node --test`'s reporter counts a skipped `describe`'s tests as
_zero tests_ rather than as _skipped tests_:

```
﹣ postgres row-level security (1.2633ms) # no PostgreSQL
ℹ tests 0
ℹ skipped 0
```

The PostgreSQL suites skip themselves with a stated reason when no cluster can start — the honest
design decision Phase 01 made, so that a missing binary is not mistaken for a code defect. But it
means that on a runner where `initdb` cannot execute, all 104 PostgreSQL tests would vanish, and
`skipped` would still read `0`.

The discriminator is the end of the reporter's line: a suite that ran closes with
`✔ postgres row-level security (10060.7718ms)`, and a suite that skipped itself closes with
`﹣ postgres row-level security (1.2633ms) # no PostgreSQL`. The check requires a line ending in
`ms)`, which is what separates a proof from an excuse.

The floor in (2) is the backstop: with every PostgreSQL suite skipped, `pass` reads 147.

### The gate was watched failing

An assertion nobody has seen go red is not a gate. The assertion script was extracted verbatim from
the workflow and run against six log shapes:

| Log shape                                    | Expected | Result                                      |
| -------------------------------------------- | -------- | ------------------------------------------- |
| the real 251-test run                        | accept   | ✅ exit 0                                   |
| every PostgreSQL suite skipped itself        | reject   | ✅ names all 13 suites, and the 147 floor   |
| one suite silently deleted, counts plausible | reject   | ✅ names `postgres row-level security`      |
| `pass 250` — a test quietly lost             | reject   | ✅ floor                                    |
| log truncated mid-run — the hang             | reject   | ✅ "the suite did not reach its own report" |
| `fail 1`                                     | reject   | ✅                                          |

## 8. embedded-postgres on a GitHub-hosted runner

Requirement 5 is that the PostgreSQL proof stays self-contained: no Docker, no service containers,
no Redis, no Temporal, no external database. It does. The workflow adds nothing but Node and the
repository's own `node_modules`.

The compatibility question — can these binaries run on `ubuntu-24.04`? — cannot be answered by
executing them from this Windows development machine, so it was answered by inspecting the
published `@embedded-postgres/linux-x64@17.10.0-beta.17` artifact directly:

| Property                | Finding                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Binary                  | `native/bin/postgres`, ELF64 x86-64, interpreter `/lib64/ld-linux-x86-64.so.2`                                                    |
| Highest glibc symbol    | `GLIBC_2.25` — Ubuntu 24.04 ships 2.39, Ubuntu 22.04 ships 2.35                                                                   |
| `DT_RUNPATH`            | `$ORIGIN/../lib` — it finds its own libraries beside itself                                                                       |
| `DT_NEEDED`             | libxml2.so.2, libssl.so.1.1, libcrypto.so.1.1, libz.so.1, libicui18n.so.60, libicuuc.so.60, plus libc/libm/libpthread/librt/libdl |
| Bundled in `native/lib` | its own OpenSSL 1.1, ICU 60, libxml2, liblzma, libz — 123 files                                                                   |

So the package does not depend on the host having OpenSSL 1.1 or ICU 60, which Ubuntu 24.04 does
not ship. It carries them.

**One dependency of that is load-bearing and easy to break.** `libicui18n.so.60` and
`libicuuc.so.60` are _symlinks_, and an npm tarball cannot carry symlinks; the package restores them
in a `postinstall` (`hydrate-symlinks.js`). Running `npm ci --ignore-scripts` — a reflex on many
hardened CI setups — leaves those sonames missing and the server cannot start at all. The workflow
comments say so at the install step.

The runner also must not be root: PostgreSQL refuses to `initdb` as root, and so does this harness.
GitHub-hosted runners execute as `runner`; a container-based runner would not. The preflight step
checks `id -u` and fails with that explanation rather than letting it surface as a mysterious
`initdb` error four minutes into the suite.

**The preflight step is the honest answer to requirement 11.** Rather than assume compatibility, it
executes `initdb --version` and `postgres --version` on the bundled binaries in the first seconds of
the job. A missing shared object, a missing platform package, or a broken symlink hydration fails
there, in one second, with a message that says the suite must not be weakened in response.

If the binaries do turn out not to run on `ubuntu-24.04`, the smallest correct adjustment — in
order of preference — is: pin `runs-on: ubuntu-22.04` (same package, older glibc and ICU baseline);
failing that, pin an older `@embedded-postgres/*` line that publishes binaries known to run there.
Neither reduces coverage. What must **not** happen is letting the suites skip themselves and calling
the build green; that is precisely the outcome §7 exists to make impossible.

## 9. Local verification result

Every command the workflow runs was run on the exact tree being committed, on Node 24.16.0.

| Gate                                          | Result                                                        |
| --------------------------------------------- | ------------------------------------------------------------- |
| `npm run format:check` + `lint` + `typecheck` | pass, 0 errors, 44.0 s combined                               |
| `npm run verify` (all four gates)             | **exit 0**                                                    |
| — of which `npm test`                         | **251 tests, 251 pass, 0 fail, 0 skipped**, 134.2 s           |
| PostgreSQL suites in that run                 | all 13 ran; none skipped                                      |
| `npm run demo`                                | exit 0, output contains `All outbound actions are SIMULATED.` |
| Assertion step, against the real log          | exit 0 — `pass=251 fail=0 skipped=0 floor=251`                |
| Assertion step, against five broken logs      | rejects every one of them (§7)                                |
| `.github/workflows/verify.yml`                | parses, and is already Prettier-clean                         |

Total `npm run verify` wall time locally: **~3.0 minutes** (44 s static gates + 134 s tests). The
10-minute step ceiling leaves substantial headroom for a shared 4-vCPU runner, where `initdb` is
typically faster than on Windows but everything else is slower. If real runs start landing above
about seven minutes, raise the step and job ceilings together rather than trimming the suite.

Two steps have no local equivalent on Windows and are therefore **unproven**: the `pgrep`-based
stray-cluster check, and `actions/upload-artifact`. Both are diagnostics; neither can turn a red run
green.

## 10. Review

**Secrets.** The workflow references no secret, declares `permissions: contents: read`, and uses
`pull_request` rather than `pull_request_target`, so a fork PR runs with no write token and nothing
to exfiltrate. `.env.example` contains placeholders only. The only credentials in the repository
remain the throwaway local role passwords in `tests/support/postgres.ts`, on a cluster that exists
inside `node_modules` and is deleted with it — unchanged from Phase 01, and no new exposure.

**Test artifacts.** Nothing generated by a run is committed. The verification log is written to
`$RUNNER_TEMP`, deliberately outside the workspace: `prettier --check .` runs _inside_ the very
command that produces the log, and a log file in the tree would be a file the gate creates and then
judges. `git status` shows only `.github/` and `docs/HANDOFF-CI-GATE.md` as new.

**Platform-specific assumptions.** `src/` and `tests/` contain no reference to `win32`,
`process.platform`, `.exe`, `localhost`, or a drive-letter path. The multi-process worker proof
spawns `process.execPath` with a resolved script path; the harness binds `127.0.0.1:0` for a free
port and uses `os.tmpdir()` for its data directory. `.gitattributes` normalises to `eol=lf`, so a
Linux checkout satisfies Prettier's default `endOfLine`. The suite glob is quoted in
`package.json`, so the shell never expands it and Node's own matcher runs on every platform.

**Runner drift.** `ubuntu-24.04` is pinned rather than `ubuntu-latest`, and the actions are pinned
to major versions (`checkout@v4`, `setup-node@v4`, `upload-artifact@v4`). Bumping either is a
deliberate commit.

## 11. Open blockers

1. **No git remote.** `git remote -v` is empty. The workflow cannot fire until this repository is
   pushed to GitHub. Until then, "CI gate" describes a file, not a running gate — which is why the
   verdict is PARTIALLY, not READY.
2. **The gate has never gone green on a runner.** Compatibility is argued from the ELF metadata in
   §8, not observed. The preflight step is designed so that if the argument is wrong, the first run
   says so in one second and in plain language.
3. **Two steps are unproven** because Windows has no equivalent: the stray-cluster `pgrep` check and
   the artifact upload (§9).
4. **The 15-minute job ceiling is untested against a real runner's speed.** It is the required
   value, not a measured one.
5. Carried from Phase 01, unchanged and not addressed here: `AccountRepository.findBySlug` and
   `EventOutbox.markRelayed` still throw `NotImplementedError`, and the reaper still has no
   scheduler.

## 12. Exact readiness for Phase 02

Phase 01's blocking condition was "add a CI job running `npm run verify` with a hard wall-clock
timeout, before any Phase 02 work begins." That job now exists, its logic is proven, and its failure
modes have been demonstrated rather than assumed. The one thing standing between it and a genuine
signal is a `git remote`, which is a five-minute operation and requires no code change.

**Phase 02 is unblocked once the first run of this workflow is observed green on a GitHub-hosted
runner.** That is one push away. Nothing in Phase 02 should start before that run exists, because
the entire point of the gate is that a proof nobody has watched complete is not a proof — which is
the lesson Phase 01 paid for twice.

Still not production-ready, and still deliberately so: no Meta, no live model, no HTTP transport,
no operator UI.
