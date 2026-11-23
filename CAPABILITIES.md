# Verified integration scope — Codex Relay 0.2.0

Local verification date: 2026-11-23. Environment: macOS, Node.js 22.22.2, official `codex-cli 0.166.0-alpha.5.1` bundled at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.

## Public Codex app-server

Inspected CLI help and generated TypeScript protocol definitions using the installed executable. Required methods: `initialize`, `account/read`, `account/rateLimits/read`, `thread/start`, `thread/read`, `thread/resume`, `thread/turns/list`, `turn/start`, `turn/interrupt`. Shared CLI adoption additionally uses `thread/loaded/list` and `codex app-server proxy --sock`. Discovery uses `thread/list`.

Generated types distinguish thread ID from session ID and expose structured terminal errors, current runtime flags, canonical turn pagination and effective settings. `GetAccountRateLimitsResponse.ordinaryUsageAllowed` explicitly requires backend permission instead of inferring recovery from percentages or timestamps.

Real initialization, ChatGPT-account reads and rate-limit reads succeeded without starting a model turn. The response contained account identity, boolean ordinary-usage permission and the `codex` quota bucket; actual account IDs and usage values are not included here. `relay doctor` verifies required installed schema features before a daemon starts. Historical releases lacking explicit permission verification are unsupported.

[Official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server) describes the public JSON-RPC lifecycle and thread/turn workflow. Installed generated types establish this alpha build's field contracts.

The local default shared control socket did not exist. Shared CLI adoption is implemented and simulation-tested, but a real shared CLI adoption/continuation was not exercised. A task must already be loaded in the selected shared server; private-server or disk-only history is never treated as ownership evidence.

## Existing desktop tasks

Inspected the installed `app.asar` without modifying it. Confirmed these local IPC protocol versions: initialize 0, owner discovery 1, following changes 1, state stream 11, owner-directed start-turn 2. Confirmed little-endian length-prefixed JSON framing and the follower acknowledgement envelope.

A real `relay inspect --thread ...` succeeded against an already-running desktop chat that was not started through Relay. Verified owner discovery, live canonical history, active runtime, empty requests, exact thread/session/turn identity, cwd, model, collaboration mode, current permissions and effective settings. No monitor was enabled and no task prompt or approval was sent.

The desktop bridge is experimental and distinct from the official public app-server API. It discovers and follows the current app owner; it does not register an owner, answer approvals, or resume the conversation in an unrelated private server. Full snapshots must arrive from the discovered owner using stream version 11. Partial patches invalidate state. Canonical history requires a complete latest tail. Optional empty queue fields can be omitted by this verified protocol; nonempty or malformed fields stop automation.

Desktop model, effort, collaboration settings, sandbox, approval routing, plugins and environment are inherited by the original owner. Relay sends only the selected thread ID, client message ID and continuation text. Existing Codex auto-review settings remain Codex's responsibility; Relay never makes approval decisions or enables automatic review.

## Architectural references

- [ShageeshanT/codex-autoresume](https://github.com/ShageeshanT/codex-autoresume): reviewed README and package manifest. Its experimental remote-server terminal supervisor informed persisted interruption/reset recovery. Relay avoids PTY scraping and uses separate private, shared CLI and desktop-owner integrations.
- [progressrdx/codex-auto-resume](https://github.com/progressrdx/codex-auto-resume): reviewed README and `policy.py`, `rpc.py`, `app.py`, `controller.py`, `tasks.py`. Its separation of discovery, live ownership, quota checks and dispatch informed external adoption. Locally verified the protocol against this installed app before implementing the TypeScript adapter. No source was copied verbatim.

## Validation boundaries

Automated tests cover core reset/restart safety, existing-task enrollment, refusal of terminal tasks and pending input, framed socket transport, owner-directed delivery, unknown protocols, permissions, duplicates, cancellation, backoff, uncertain submissions and a real CLI/daemon with synthetic Codex and desktop endpoints. The synthetic adoption test exercises the entire daemon path without contacting a model.

Actual exhausted-account recovery, real model continuation through either external adapter, shared CLI adoption, and launchd login/reboot behavior remain untested end to end. Preflight checks and start requests are not upstream atomic compare-and-swap operations; avoid simultaneous manual sends/settings edits at the reset boundary. Loss of live owner, uncertain delivery or incompatible state stops automation.


## Additional verification — 2026-11-23

Cloned the public GitHub repository into a clean directory. `npm ci`, TypeScript
compilation, the generated package install, and `relay doctor` succeeded. All 39
standard tests passed against the public runtime. Real account/allowance metadata
reads and desktop ownership inspection succeeded; repeated live snapshots retained
the same session/turn identity and settings during normal progress.

Added an opt-in `npm run test:launchd` test. It passed using an actual macOS user
LaunchAgent and simulated Codex/desktop endpoints. launchd started the daemon, the
monitor sent exactly one continuation to the fake original owner, and its durable
state recorded the acknowledged new turn in the same synthetic session. The
service, plist, and test state were removed afterward. No real model prompt or
permission decision was sent. Physical login/reboot recovery, real shared CLI
adoption, and a natural exhausted-account reset remain outside this validation.
