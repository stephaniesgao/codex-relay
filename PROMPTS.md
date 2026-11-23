# Agent setup prompts

Paste a prompt into the chat whose task you want monitored. Enrollment must use an authoritative exact UUID, not a guess based on recency. These prompts authorize installation/enrollment, not approval bypasses or an immediate continuation.

## Install and monitor this existing chat

Use the complete [agent-prompt setup in the README](./README.md#agent-prompt-setup). It covers installation, authentication checks, identity, compatibility, launchd enrollment, and continuing the original unfinished task.

## Reuse an existing Relay installation

Replace `/absolute/path/to/codex-relay` with your verified installation directory before pasting:

```text
Use the Codex Relay installation at /absolute/path/to/codex-relay to monitor this
existing chat. Read README.md and CAPABILITIES.md there first. Verify the repository
identity and run its doctor command. Obtain this chat's exact UUID from authoritative
current-session metadata. If that is unavailable, show me relay list and ask me to
select; never guess the newest task or choose by title alone.

Run relay inspect --thread UUID. Use the desktop owner for a desktop chat; use
--source cli only for an already-loaded task in the verified official shared server.
Enable monitoring with relay start --thread UUID --launchd, then confirm status and
logs. Use node /absolute/path/to/codex-relay/dist/cli.js instead of relay if needed.
Do not create a replacement chat or executor, submit a continuation now, change
accounts/policies, auto-approve requests, or clear an uncertain submission block.

After enrollment, continue the original unfinished task in this same chat and turn.
If the task is complete or needs my input, stop normally. Report the exact UUID,
installation path, monitoring phase, and limitations at the next task update.
```

## Monitor a different explicitly selected task

Replace the UUID and installation path yourself before pasting. This prompt does not authorize monitoring whichever task happens to be most recent.

```text
Enroll exactly the existing Codex task with thread UUID
01234567-89ab-cdef-0123-456789abcdef in Codex Relay monitoring.

Use my verified installation at /absolute/path/to/codex-relay. Read its README.md,
run doctor, inspect that exact task, and confirm its live owner, cwd and eligibility.
Do not substitute this chat or another task if the UUID is unavailable. If the task
is running or has a structured quota interruption, enable its user launchd monitor
and verify status. Use --source cli only if it is owned by the verified official
shared CLI server; otherwise use its desktop owner.

Do not send a prompt to the target task now, change its settings or account, approve
requests, fork it, restart cancelled/completed work, or clear a safety block. Relay
may send its continuation only after a verified usage-limit failure and allowance
recovery. Report the selected UUID, monitoring phase and any blocker.
```

For a private repository, the agent needs existing GitHub access. Never include tokens in a prompt. Follow the host's normal approval requirements for filesystem, network, sockets and LaunchAgents.
