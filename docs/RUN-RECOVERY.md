# Durable run events and read-only recovery

The session ledger names the native CLI session. `run-history.jsonl`, beside
that ledger, records control requests, native acknowledgements and owned root
process observations. Neither file copies the native conversation or runs an
agent loop. The existing dashboard task statuses and six MCP tools are unchanged.

## Inspect an exact run

```sh
node dashboard/cli.mjs session-ledger start --project /workspace/project \
  --executable /absolute/path/to/original-dsh
node dashboard/cli.mjs run-history list --project /workspace/project
node dashboard/cli.mjs run-history inspect --project /workspace/project \
  --run-id run_00000000-0000-0000-0000-000000000000
node dashboard/cli.mjs run-history events --project /workspace/project \
  --run-id run_00000000-0000-0000-0000-000000000000
```

Use the actual `run_id` returned by session-ledger. Reads observe only this
project's recorded process IDs. They never send a prompt, signal, acknowledgement
or restart request. The CLI's start/resume lifecycle still stops its owned ACP
process after verifying attachment; a surviving native session ID can be resumed
later by an explicit request.

Run lists default to ten entries and allow at most twenty. Event pages default
to one hundred. Pass `next_cursor` with `--cursor` for the next page and optionally
`--limit`. Inspect includes the latest one hundred commands and twenty rejected
transitions; paged events retain the full committed history. The journal stops
accepting new writes at 16 MiB or 20,000 events rather than silently dropping old
command IDs.

## Meaning of a run state

| State                  | Last recorded meaning                                               |
| ---------------------- | ------------------------------------------------------------------- |
| `queued`               | A request is retained; it has not begun attachment                  |
| `starting`             | An explicit attachment attempt was recorded                         |
| `running`              | The current client has a native prompt request in flight            |
| `waiting-human`        | The CLI acknowledged attachment or a prompt result; it awaits input |
| `waiting-resource`     | An upper layer recorded a resource wait; no lease is invented       |
| `disconnected`         | The owned root process exited or its recorded identity is absent    |
| `stopping`             | An owned stop was requested; exit has not yet been confirmed        |
| `succeeded` / `failed` | An upper layer explicitly recorded a terminal result                |
| `unknown`              | The native state or operation outcome cannot be confirmed           |

`recorded_state` is historical. Inspect separately reports a fresh OS process
observation and the effective `state`. A live matching PID does not establish
that a model is making progress or that a session is idle. After client restart,
an alive process therefore yields `unknown` with that exact reason. A known
process exit does not imply that the task or its native conversation is complete.
Attachment, a prompt response and process exit never mark a task `succeeded`.
Acceptance and evidence gates remain a separate concern.

`ui_connection` is a separate observation supplied by the caller; CLI inspection
defaults to `unknown`. Browser disconnection is never a run transition. This
change adds no browser run-control UI and does not claim a physical phone test.
An invalid transition is refused and its reason/event ID remain in the journal.

## Read-only stall diagnostics

`run-history inspect` includes `stall_diagnosis`. The project dashboard's
「実行の停滞診断」 panel reads the latest five run records on demand. It combines
owned-process observations, the recorded run state, an in-flight `send` command,
and metadata-only ACP activity heartbeats. ACP update names are allowlisted and
coalesced to at most one observation per minute; message, tool, and prompt
contents are never copied into storage. The latest activity and resource
observations live in a bounded companion file, written atomically under the run
history writer lock, so the schema-1 event journal remains readable by older
builds. A corrupt companion file makes these signals unavailable without
blocking run-history reads. A heartbeat is considered recent for 90 seconds to
allow for that sampling interval. Resource providers may record a resource
kind and wait state; a resource kind is shown only when a provider explicitly
reported it.

Recent ACP activity is measured from its recorded timestamp. A dispatched send
with a live process and no recent heartbeat is labeled `api_wait_possible`; after
five minutes it becomes `stall_suspected`. That is an inference, not a confirmed
failure. The output includes each source, observation time, elapsed age, and
confidence. CPU, GPU, and stdout counters are currently unavailable and are shown
as missing, never as zero. A resource wait, human wait, process exit, or browser
disconnect remains a distinct observation. No diagnosis sends a signal, kills or
restarts a process, or replays a prompt.

## Requests, responses and uncertainty

Start, resume, send, interrupt and stop receive unique `command_id` values.
Intent and dispatch records are flushed before forwarding a control operation.
Actual native responses receive separate `ack_id` values. A duplicate command ID
cannot be dispatched from the journal again. Re-reading committed events changes
neither the journal nor the native CLI.

ACP cancellation is a notification with no correlated response ID. Sending it
records `notification_sent`, with no acknowledgement. The later cancelled prompt
result is a separate observed fact, not an invented acknowledgement of every
cancel request. A normal prompt result confirms receipt of a native result;
semantic application of a follow-up instruction is not inferred from it.

A crash after dispatch and before acknowledgement may leave an external effect
already applied. Recovery preserves `unknown` and performs no automatic retry.
This is not an exactly-once guarantee for arbitrary CLI side effects. A fresh
resume request refuses to attach while the previous root process is alive or
unverifiable, preventing a second attachment from silently taking over that run.

## Process identity and storage limits

Windows observations use PID and
[Process.StartTime](https://learn.microsoft.com/dotnet/api/system.diagnostics.process.starttime),
scoped by a local machine fingerprint. The registry query is read-only; only
the fingerprint hash enters the journal. Absence observations carry their scope
too: a missing PID on a different host is not evidence that the old run exited.
Linux observations use the kernel's
[/proc/PID/stat starttime](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html),
with boot/PID-namespace scope. A changed birth token in the same scope identifies
PID reuse. A different host, boot or namespace remains unverified rather than
authorizing control of that PID. Missing permissions and unsupported OS identity
queries retain `unknown`; the live client can still confirm its own child exit.
Only the owned root is observed. Descendant tracking and stopping are a separate
feature; this journal does not claim that every descendant exited.

Events have a schema, project ID, monotonically increasing sequence, event ID
and checksum chain. A single writer holds an exclusive lock; independent writers
cannot overwrite a stale projection. Newline-complete, validated events form
the recoverable prefix. File data is flushed with `fsync` before a mutation
returns. Crash fixtures exercise process termination, not storage-device failure
or loss of power; the checksum is corruption detection, not an authorization key.

A torn final frame preserves the committed prefix, marks state uncertainty and
blocks further writes. Invalid complete frames, foreign project IDs or unknown
schemas are rejected without replacing the file. A surviving writer lock also
permits read-only inspection: its observed owner is shown, and it is never
automatically stolen. Tail/lock repair and schema migration are explicit future
maintenance operations; the runtime does not truncate uncertain data on startup.

If journal writing fails, a new profile or prompt is blocked. Cleanup of an
already owned child still proceeds. The stop result distinguishes a confirmed
process exit from unconfirmed history persistence. The journal contains IDs and
bounded control metadata, not environment values, credentials, command lines,
prompt bodies, native output or peer error text.
