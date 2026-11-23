# Codex Relay

A local TypeScript daemon that automatically continues Codex tasks after verified usage-limit resets. Supports new Relay-owned tasks **and existing desktop/shared CLI tasks**, selected by exact thread UUID. Requires Node.js 22+, npm, and a signed-in official Codex CLI with the capabilities checked by `relay doctor`. No runtime npm dependencies.

## Choose your setup path

- [CLI setup](#cli-setup): install in your terminal, choose a task, and enable monitoring yourself.
- [Agent-prompt setup](#agent-prompt-setup): paste a prompt into the Codex chat you want monitored and have the agent perform the setup.
- [Existing desktop tasks](#monitor-an-existing-desktop-task) and [existing CLI tasks](#monitor-an-existing-cli-task) explain the two ownership paths.
- [Controls](#controls), [troubleshooting](#troubleshooting), and [updates and uninstall](#updates-and-uninstall) cover daily operation.
- [Safety](#quota-and-crash-safety) and [validation](#validation) explain what Relay verifies and what remains untested.

**Experimental:** read-only desktop inspection and 39 automated tests pass. A natural exhausted-account reset, real external model continuation, shared CLI adoption, and launchd reboot recovery have not been validated end to end. Relay stops for human attention when it cannot verify safety. It is an unofficial local tool, not an OpenAI product.

## CLI setup

### 1. Check prerequisites

You need macOS for launchd background operation, Node.js **22 or newer**, npm, Git, and an official Codex CLI already signed in with ChatGPT. Desktop adoption also requires the Codex desktop app running with the selected task open. Shared CLI adoption requires an already-running compatible official shared app-server daemon.

```sh
node --version
npm --version
git --version
codex --version
```

If Codex is not signed in, run `codex login` and complete its normal sign-in flow yourself. Relay reuses the existing login. It does not require its own API key, modify login credentials, or switch accounts.

The verified CLI build is `0.166.0-alpha.5.1`; compatibility with every newer or older build is not assumed. `relay doctor` checks required protocol capabilities, including `ordinaryUsageAllowed`. Older versions without that field are refused.

### 2. Clone and install

Keep the clone in a persistent directory. `npm link` points to it, and launchd records absolute paths to the installed script and Node executable.

```sh
git clone https://github.com/stephaniesgao/codex-relay.git
cd codex-relay
npm ci
npm test
npm link
relay doctor
```

`npm ci` installs the development tools and runs the build through `prepare`. There are no runtime npm dependencies. The tests use synthetic Codex processes and sockets; they never send a real model prompt. `doctor` checks the selected CLI version and generated protocol schema; it does not prove login, thread eligibility, or end-to-end recovery.

If this repository is private, authenticate Git with an account that has access, or use `gh repo clone stephaniesgao/codex-relay` after `gh auth login`. Do not paste a token into a clone URL.

If global npm registration is unavailable, omit `npm link` and replace each `relay` command with:

```sh
node /absolute/path/to/codex-relay/dist/cli.js
```

For example:

```sh
node /absolute/path/to/codex-relay/dist/cli.js doctor
```

An optional local tarball install can be built with `npm pack` and installed using `npm install -g ./codex-relay-0.2.0.tgz`. A tarball or npm registry release is not required for the source installation above.

### 3. Find the UUID of an existing task

```sh
relay list
```

Each line is a JSON object with `threadId`, `name`, `cwd`, `source`, and indexed `status`. Find the intended task by its name and directory, then copy the **entire `threadId` value**. The UUID looks like `01234567-89ab-cdef-0123-456789abcdef`; that example is not a real task to monitor.

Use the UUID as the value of `--thread`, without angle brackets. Do not use a title, session filename, rollout path, or “latest” selection. For repeated commands, store the real value in a shell variable:

```sh
# Replace the example value with the threadId from your own task.
THREAD_ID="01234567-89ab-cdef-0123-456789abcdef"
relay inspect --thread "$THREAD_ID"
```

`list` does not authorize a continuation. `inspect` checks whether the chosen task has a live owner, is running or quota-interrupted, and has no detected blocking state. For desktop tasks, open the exact task in the app before inspecting it.

### 4. Enable background monitoring

For an existing desktop task:

```sh
relay start --thread "$THREAD_ID" --launchd
relay status --thread "$THREAD_ID"
relay logs --thread "$THREAD_ID"
```

Look for `phase: "running"` or `phase: "waiting"` in status. `running` means Relay is monitoring the existing turn. `waiting` means it recorded a structured quota interruption and is waiting/checking for allowance. `blocked` means human attention is required; inspect `reason` and the logs. `completed` and `stopped` do not automatically rearm.

launchd registration returns before initialization finishes. If status briefly says the daemon is offline, retry status after a few seconds and inspect `daemon.log` under the task's state directory if startup fails. Enrollment itself sends no continuation prompt. The Mac must be awake and the desktop app must retain a live owner for the selected task.

Without launchd, `relay start --thread "$THREAD_ID"` starts a detached daemon that survives closing the terminal but is not automatically started at login. Add `--foreground` when you want the daemon attached to that terminal for debugging.

## Agent-prompt setup

Paste the prompt below into the **existing Codex chat whose unfinished task you want monitored**. It authorizes installation and background enrollment for that chat. You do not need to know its UUID if the agent can obtain it from authoritative host/session metadata. If it cannot, it must ask you to select the exact task rather than guess from titles or recency.

```text
Set up Codex Relay to monitor this existing chat for usage-limit interruptions.

Repository: https://github.com/stephaniesgao/codex-relay

1. Read README.md and CAPABILITIES.md from that repository. Reuse a verified
   existing checkout, or clone it into a persistent user-owned directory outside
   the repository used by my original task. Do not overwrite an unrelated clone.
2. Check Node.js 22+, npm, Git, the official Codex CLI, and existing ChatGPT login.
   Install Relay with npm ci, run npm test, and run npm link if permitted. If global
   registration is unavailable, invoke its dist/cli.js with an absolute Node path.
   Run relay doctor. Do not change accounts or expose authentication tokens.
3. Obtain THIS chat's exact thread UUID from trusted current-session metadata.
   Do not guess “latest” or select by title alone. If no authoritative ID is
   available, run relay list and ask me to select the exact task.
4. Run relay inspect --thread UUID. For a desktop chat, keep the desktop owner.
   For an existing shared CLI task, use --source cli only if the selected live
   server owns that task. If identity or compatibility is uncertain, stop and
   explain; do not create a replacement conversation or private executor.
5. Enable background monitoring with relay start --thread UUID --launchd
   (and --source cli only for the verified shared CLI path). Check relay status
   --thread UUID and the logs until enrollment is confirmed or a concrete error
   appears. Preserve the task's model, directory, sandbox, and approval policies.
6. Do not send a continuation now, approve any permission requests automatically,
   or clear a safety block. Relay may continue only after a structured usage-limit
   failure and freshly verified allowance. Never rearm completed or cancelled work.
7. After setup, continue the ORIGINAL unfinished task in this same chat and turn.
   Do not end the turn merely to announce that setup finished. If the original task
   is already complete or requires my input, say so and stop; Relay must not revive it.

Report the installed path, exact enrolled UUID, monitoring phase, and any remaining
limitations when you next provide a task update. Follow the host's normal approval
rules; this prompt does not bypass them.
```

The agent may need normal host permission to install tools, use sockets, write its user LaunchAgent, or access a private repository. Relay does not grant those permissions. If the original task ends normally after setup, monitoring also ends normally; this tool recovers quota failures, not arbitrary pauses or every completed turn.

For prompts that reuse an existing installation or monitor a different explicitly selected task, see [PROMPTS.md](./PROMPTS.md).

## Monitor an existing desktop task

You do **not** need to restart your task through Relay.

```sh
relay list
relay inspect --thread YOUR-THREAD-UUID
relay start --thread YOUR-THREAD-UUID --launchd
relay status --thread YOUR-THREAD-UUID
```

`list` discovers non-archived local sessions using the official read-only app-server listing API. It prints exact thread UUIDs, names, directories, source and indexed status. Indexed status is not authorization to send: `inspect` checks the live owner and canonical latest turn. Open the selected task in the desktop app if its owner is unavailable.

`start --thread` enrolls that specific existing task. It sends no enrollment prompt, creates no conversation, and does not transfer ownership. The task must be running or have a structured quota failure. A normally completed or manually cancelled task is ineligible. With `--launchd`, enrollment initializes asynchronously; check status and logs for success. Without that flag, the daemon detaches from the terminal and prints enrollment state.

The desktop integration discovers the current owner through the app's local IPC, follows its live state, verifies pending requests, queues, goal state, session identity and settings, and asks the same owner to start the continuation after allowance recovery. It uses the installed experimental owner/follower protocol; this is **not** the public CLI app-server protocol. Relay never becomes an approval handler or thread owner. Keep the app running, the exact task loaded, and the Mac awake for unattended recovery. Losing the owner or socket stops monitoring for attention; there is no unsafe disk-only fallback.

Existing tasks retain their sandbox, approval routing, collaboration mode, reasoning settings, plugins and environment. Relay submits no policy overrides and makes no approval decisions. An existing automatic approval reviewer continues to be controlled by Codex's own configuration; Relay does not enable or act as that reviewer. Approval or user-input requests in live state stop Relay.

## Monitor an existing CLI task

For a task running in the official **shared app-server daemon**:

```sh
relay inspect --thread YOUR-THREAD-UUID --source cli
relay start --thread YOUR-THREAD-UUID --source cli --launchd
```

Uses `codex app-server proxy --sock ...` to connect to the task's live server. Default endpoint: `$CODEX_HOME/app-server-control/app-server-control.sock`, or `~/.codex/app-server-control/app-server-control.sock`. Override with `--socket /absolute/path/to/server.sock`. The server must already exist and the task must be loaded there; Relay does not start, stop or restart that shared server. `thread/resume` rejoins the selected loaded task with no execution overrides.

A standalone CLI invoked with `--no-daemon`, an unrelated private server, a remote/cloud host, or a disk-only saved thread cannot be adopted through this path. A saved CLI task can be monitored through the desktop adapter after you explicitly open it in the app and it has eligible live state. Do not run a second independent executor against the same thread.

The CLI adapter checks active flags and blocks on matching server requests, settings changes, queue changes, goal changes and lifecycle events after attachment. Public CLI snapshots expose fewer pending-work details than desktop snapshots; the desktop path is preferred for desktop-owned work. The shared CLI adapter is simulation-tested; no suitable shared daemon was running here for a live adoption test.

## Controls

Use the same thread selector for external tasks:

```sh
relay status --thread YOUR-THREAD-UUID
relay logs --thread YOUR-THREAD-UUID --follow
relay pause --thread YOUR-THREAD-UUID
relay resume --thread YOUR-THREAD-UUID
relay stop --thread YOUR-THREAD-UUID
relay start --thread YOUR-THREAD-UUID  # restart persisted monitoring
```

`pause` suspends automatic continuation without cancelling active work. `resume` only re-enables explicitly paused monitoring, after checking the actual task. It does not clear attention blocks or manually submit a continuation. For an external task, `stop` **only disables monitoring**; use Codex's own UI to cancel work. Offline `pause` and `stop` persist under the daemon lock. An offline paused monitor can be restarted with `start`, then resumed.

Each external UUID has its own state subdirectory and launchd label, so separate tasks can be explicitly enrolled independently. There is no blanket auto-resume of every unfinished chat. Re-running `start` does not rearm a completed, cancelled, stopped, blocked or delivery-uncertain monitor. Inspect the original session before choosing to create a new monitoring state directory.

To remove a task's launchd service after stopping monitoring:

```sh
relay stop --thread YOUR-THREAD-UUID
launchctl bootout "gui/$(id -u)/local.codex-relay.YOUR-THREAD-UUID"
rm "$HOME/Library/LaunchAgents/local.codex-relay.YOUR-THREAD-UUID.plist"
```

LaunchAgents run while the user is logged in. A sleeping Mac cannot execute work; deadlines are checked after waking. `stop` leaves an idle daemon with no quota/model requests; launchctl bootout ends its process.

## Start a new Relay-owned task

```sh
relay start --prompt "Finish the unfinished work and run the tests" --cwd /absolute/path/to/project --launchd
relay status
relay logs --follow
```

Without `--launchd`, the daemon detaches from the terminal. `--foreground` runs it in the terminal. Controls use no `--thread` selector for this mode. `--model` selects the initial model; `--limit-id` selects a known applicable quota bucket (default `codex`). Existing tasks inherit their model and cannot use `--prompt` or `--model` during enrollment.

The private app-server for this mode is owned by Relay. Its initial configuration must use human approval routing and a sandbox; Relay refuses automatic reviewers, `approvalPolicy: never`, full-access sandboxes and non-OpenAI providers for newly created tasks. `stop` in this mode interrupts a known active turn as well as disabling monitoring.

## Quota and crash safety

- Only a terminal `failed` turn with structured `codexErrorInfo: usageLimitExceeded` authorizes waiting. Terminal text, generic HTTP 429s, `rateLimitExceeded`, normal completion and manual `interrupted` status never do.
- Exact thread UUID, distinct session ID, cwd, effective model/settings, interruption turn, retry deadline and monitoring phase are persisted. External tasks are inspected every five seconds, including while waiting for reset; these are local metadata reads, not model requests.
- Sparse `account/rateLimits/updated` events are audit hints. Only a fresh `account/rateLimits/read` for the bound account can authorize continuation. Requires `ordinaryUsageAllowed === true`, non-exhausted valid windows and no contradictory backend restriction.
- Waits for the latest applicable exhausted window reset plus 15 seconds. Unknown or stale reset data uses bounded exponential backoff: 1 minute initially, capped at 1 hour, at most 12 checks per interruption. No continuous model probes.
- Before sending, rechecks the current owner, canonical latest turn and execution settings. Desktop compares a fingerprint of the task, permissions, pending work and goal state. Partial/missed stream patches invalidate the snapshot.
- A per-session lock and daemon lock prevent duplicate sends within the monitoring state. Do not enroll the same UUID under multiple `RELAY_HOME` roots or run multiple Relay installations against it.
- State writes use atomic rename with file and directory fsync. A durable `submitting` record precedes each continuation; any restart or timeout with uncertain delivery requires manual inspection rather than replay. Client message UUIDs are included but are not assumed to guarantee idempotency.
- After a confirmed submission, a bounded 30-second allowance for the owner's snapshot to reflect the acknowledged turn prevents duplicate sends while state catches up. No send is allowed during that interval based on the prior failed turn.
- Both adapters recheck before dispatch, but the upstream check/start operations are not an atomic compare-and-swap. Avoid concurrent manual sends and settings edits at the reset boundary. A newly detected change stops automation; no terminal/UI scraping is used to work around incompatibilities.

## Local files

Default root: `~/.local/state/codex-relay/` (`RELAY_HOME` overrides it). External task state: `threads/UUID/` beneath that root. The directory is 0700; state, audit log and control socket are 0600. `state.json` stores identity, settings and recovery state. `relay.jsonl` records enrollments, interruptions, checks, schedules, intent, acknowledgements and stops. `daemon.log` records startup diagnostics. Logs are local and not automatically rotated. Credentials and model/tool output are not intentionally logged.

A short-lived private bootstrap record carries the initial prompt or explicit enrollment to a detached/launchd process. A crash during initial enrollment does not trigger a blind model request. Monitoring state persists across process restarts; an unavailable or changed owner still requires fresh live verification.

## Validation

`npm test` compiles TypeScript and runs state-machine, subprocess and Unix-socket tests. Tests cover existing running and quota-interrupted tasks, duplicate events, reset scheduling, cancellation, normal completion, pending input, permission/settings changes, unknown protocols, socket permissions, pauses/stops, owner-directed delivery, uncertain submissions and daemon restarts.

Real read-only desktop inspection succeeded against a task that was **not** started through Relay. Official account and allowance reads also succeeded. No actual continuation was sent during verification. A natural exhausted-account reset, live shared CLI adoption, and launchd login/reboot behavior remain untested end to end. See [CAPABILITIES.md](./CAPABILITIES.md).

For custom state roots that exceed macOS's Unix-socket path limit, the control socket uses a hashed name in a private `/private/tmp/codex-relay-UID/` directory. State and audit logs remain in the selected state root.


## Troubleshooting

### `relay: command not found`

Run `npm link` from the clone and reopen your terminal if your npm bin directory was added to PATH. Or use `node /absolute/path/to/codex-relay/dist/cli.js` directly. Do not use `sudo` merely to make the install work; a user-owned Node installation or direct invocation avoids global write permissions.

### `codex` is missing from PATH

Point Relay to the official executable you use. On the verified macOS installation:

```sh
export RELAY_CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
relay doctor
```

That path is an example for the tested app bundle, not a guarantee for every installation. Use the actual official binary on your machine. Set it before installing the LaunchAgent so launchd captures the correct absolute path.

### Desktop owner unavailable, no canonical latest turn, or request timeout

Open the exact selected task in the desktop app, confirm the task is still running or quota-interrupted, and retry `relay inspect`. Do not use a different thread or disk-only history to make the check pass. If the installed app's IPC protocol changed, monitoring requires a compatible adapter; terminal scraping is not a fallback.

### CLI shared socket missing or task not loaded

The CLI adapter attaches only to the selected already-running shared server. It cannot adopt `--no-daemon` sessions or create a private server to impersonate the owner. Use the actual shared socket with `--socket`, or open an eligible task in the desktop app and use the desktop path. Relay does not restart Codex's shared daemon for you.

### Unsafe socket owner/permissions

Relay refuses sockets or IPC directories that are accessible to other users or have uncertain ownership. It will not chmod Codex's sockets automatically. Inspect the actual path and installation rather than weakening the check or launching Relay as root.

### Monitoring is blocked or submission is uncertain

Read `reason` in status, the audit log, and the original Codex task. Approvals, user input, settings changes, account changes, incompatible state and ambiguous delivery stop automation. `resume` clears only an explicit pause; it does not clear an uncertainty block. Do not delete state or create a second monitor just to force another send. Verify whether the previous continuation reached Codex before deciding how to proceed manually.

### launchd service is offline or fails after an update

Check the task's `daemon.log`, confirm the selected Node and clone paths still exist, and inspect the user service:

```sh
launchctl print "gui/$(id -u)/local.codex-relay.$THREAD_ID"
```

Use the root label `local.codex-relay` for a new Relay-owned task without a thread selector. Stop monitoring before moving the clone or changing the Node installation. Re-register the service from its stable location using the same state root. Do not interrupt an in-flight submission to perform a handover.

### Reset time passed but no continuation happened

A timestamp is only a scheduling hint. Relay still requires the backend to explicitly allow ordinary included usage, a matching account/bucket, valid non-exhausted windows, and an unchanged live task. Unknown/stale data uses bounded retries; a passed timestamp does not authorize bypassing the limit.

## Updates and uninstall

Before updating, pause monitoring and check status. Avoid changing installations during `submitting`. From the verified clone, pull only a normal fast-forward update and rerun validation:

```sh
git pull --ff-only
npm ci
npm test
relay doctor
```

A running daemon holds its old code in memory. After safely disabling monitoring and checking for uncertain delivery, restart/re-register it from the updated location as appropriate. `start` does not clear a stopped or blocked monitor; inspect the original task and persisted state before deciding whether a fresh enrollment is appropriate. Upgrades should not be used to force a retry.

To uninstall an external task monitor, first run `relay stop --thread "$THREAD_ID"`, then remove its user LaunchAgent using the commands under [Controls](#controls). Repeat for each enrolled task. If you used `npm link`, run `npm unlink -g codex-relay` after stopping its services. If installed globally from a tarball, use `npm uninstall -g codex-relay`. Keep or remove local state and audit logs only after checking for uncertain submissions. These actions do not delete Codex's original conversations.

## Development

```sh
npm ci
npm run build
npm test
npm pack
```

Source lives in `src/`; `cli.ts` is the command entry point; `test/` contains synthetic state-machine, subprocess, socket, and daemon adoption tests. `dist/`, `node_modules/`, credentials, session history, and runtime logs do not belong in Git. The GitHub Actions workflow runs the suite on macOS and Linux using Node.js 22. See [CAPABILITIES.md](./CAPABILITIES.md) for the verified protocol and end-to-end testing limits.


### Optional real launchd smoke test (macOS)

When logged in to a macOS GUI session, run:

```sh
npm run test:launchd
```

This opt-in test installs a temporary user LaunchAgent with a random task UUID,
starts the actual Relay daemon through launchd, and verifies one continuation
through a simulated desktop owner after a simulated quota failure. All Codex and
allowance endpoints are fake: no model request, login change, or real task enrollment
occurs. Cleanup unloads the temporary service, removes its plist, and deletes its
test state. Do not run it with sudo. The normal `npm test` suite uses the foreground
daemon and does not install a LaunchAgent.

On 2026-11-23, the fresh public clone passed all 39 default tests and this real
launchd smoke test on macOS. Source installation, packaged installation, official
account/allowance reads, and read-only live desktop inspection also passed. This
validates launchd startup with simulated endpoints, not physical logout/reboot
recovery or a real exhausted-account reset.
