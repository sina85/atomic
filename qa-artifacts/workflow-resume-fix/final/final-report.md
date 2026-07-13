# Workflow Resume Final Actual-TUI Matrix

## Frozen build identity

- HEAD: `b452754c7e38227b66639ffe3278f8cee2fe09d9`
- Workflow source manifest: `16f0cf2047caf764552be1d6e056f00d7b35152afe9f6b065f2d27409958031b`
- `packages/coding-agent/dist-dev/cli.js`: `552f75605db2a9fb7025dec94dad5b6cf5778974b03023422d10e23e642d328f`
- Base fixture: `ac762e71b4440093f66a1ab4c0e8c4f0203fb0c847ecfceea0d9cd47c3e947bf`
- Recoverable-failure fixture used by its dependent reruns: `b2de567baa00ae62885049c75e97fb75ed7756734c3bad3707e7a0895d77e6a5`
- Runtime workflow source copy: byte-identical to `packages/workflows/src`.

`build-hashes.txt` records the reproducible source-manifest command. Every scenario `result.json` records the same tested HEAD, source manifest, and CLI bundle; scenario fixture hashes are recorded separately.

## Actual full-screen Atomic TUI results

| Scenario | Result | Observable contract covered |
|---|---|---|
| exact-session-after-ctrl-c | PASS | Ctrl-C interruption, PID death, exact `--session <id>` reopen, pending input restored once |
| resume-picker-then-workflow-resume | PASS | CLI `--resume` picker followed by `/workflow resume` |
| fresh-empty-session-selector | PASS | Empty session without session flags discovers prior durable workflow |
| repeated-resume-across-two-prompts | PASS | Two separate resume attempts restore only the next pending prompt |
| multiple-resumable-roots | PASS | Two root IDs, deterministic recency order, independent completion |
| recoverable-failure-resume | PASS | Failed/resumable durable root resumes and reaches successful terminal state |
| completed-run-exclusion | PASS | Completed root excluded from picker and direct resume refused |
| nested-child-root-only | PASS | Root visible; nested child absent from selector |
| active-duplicate-resume-refused | PASS | Live owner retained; contender refused without duplicate dispatch |
| stale-picker-row-revalidation | PASS | Helper exits after completing root; stale row revalidated and refused |
| rapid-resume-command-burst | PASS | One recorded tmux IPC burst yields one owner and one refusal |
| selector-cancel-reopen | PASS | Escape is non-mutating; reopen resumes and completes |
| sigkill-after-next-prompt-render | PASS | Unique second prompt synchronized, PID killed to ESRCH, only pending prompt restored |
| incompatible-definition-on-resume | PASS | Repeated definition-change refusal, durable bytes unchanged, no V2 execution |

## Evidence retained

Each scenario directory preserves:

- `result.json` plus source, bundle, and fixture fingerprint evidence;
- literal tmux key/command history and full-screen TUI captures;
- authoritative durable snapshots/status reconciliation and marker counts;
- process termination/exit and final process/socket cleanup evidence;
- concise redacted session JSONL evidence (or an explicit zero-emission summary where the command emitted no session file);
- a scoped credential-value/private-config scan with zero findings.

The matrix intentionally omits isolated private HOME, cache, auth, and raw session trees. Only structural redacted session evidence remains. Global cleanup evidence reports no owned Atomic CLI process, tmux server/socket, private config residue, or credential-value match.

## Matrix result

`complete-matrix-summary.json` contains exactly 14 rows: **14 pass, 0 fail**.
