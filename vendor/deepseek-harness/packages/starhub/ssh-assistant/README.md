# @deepseek-ai/dsh-starhub-ssh-assistant

StarHub SSH AI assistant (StarHub-local package, not upstream): one agent-scoped session per SSH terminal page that operates the bound server, reusing the deployment's model connection.

## What it does

- **One assistant per terminal page.** `open` keys on the terminal page's own SSH session id; reopening the page reuses the live agent, closing the page disposes it.
- **Model connection reuse.** The agent is created with the deployment default route (`agentDefaultModel` — the provider/key/model configured in dsh settings). The panel can switch provider/model per assistant (`POST .../model`, applied on the next request through the `agent/request` waterfall).
- **Scoped tool surface.** Inside the agent's creation window the registry restricts tools to this asset's eight SSH/SFTP tools (`ssh_exec`, `ssh_exec_background`, `ssh_wait_task`, `ssh_session_status`, `sftp_list`, `sftp_stat`, `sftp_upload`, `sftp_download`) and binds the session to the asset through the bridge (`starhub/bind.asset`). The sidecar resolves the asset from the binding and executes on **the user's own terminal session** (v0.140.0). Local shell, databases, browsers, and other servers are invisible to the assistant.
- **No connection of its own.** The assistant never opens an SSH connection. Commands run in the shell the user already has connected in the terminal page (the same session, so the user sees everything in their terminal); on a bastion host the command is typed into that shell, where the user personally completed the MFA code and machine selection. With several terminal windows on the asset connected, the first live session is used. When nothing is connected the tool result says so and the assistant asks the user to connect in the terminal page.
- **Read-only by default.** The persona limits autonomous execution to read-only commands; any modification, deletion, install, or restart must be presented as a command for the user to run or hand back ("run this: …"). Write/risky commands still raise an approval card, which is the hand-over point.
- **Approvals in the panel.** Risky/write commands still pass through `starhub-approval-bridge`'s risk gate (read-only auto-allowed). An ask for an assistant session is parked on the assistant's SSE stream and settled by the panel (`allowed-once` / `rejected`); with no panel client attached the ask delegates back down the waterfall (the shell's own approval UI is unaffected).
- **Event-sourced rendering.** The stream forwards the session log verbatim (`user/message`, `assistant/message`, `tool/call`, `tool/result`, turn/step boundaries) plus `status`, `model`, `approval`, and `closed` frames.
- **Token-level streaming.** Assistant text arrives incrementally: the plugin forwards the loop's live `agent/assistant-stream` publications (`start` / `chunk` / `end`) as `stream` frames, and the panel accumulates `text-delta` chunks into a streaming bubble that the durable `assistant/message` replaces in place when the attempt commits. Stream frames are transient — never replayed; a late client is served by the durable events instead, so live and replayed views converge on the same bubble.

## Routes (same-origin, under the dsh web server)

| Route | Purpose |
|---|---|
| `POST /starhub/api/assistant/open` | `{sshSessionId, assetId, assetName}` → `{assistantId, provider, model, reused}` |
| `POST /starhub/api/assistant/prompt` | `{assistantId, text}` — queues one follow-up turn |
| `POST /starhub/api/assistant/stop` | `{assistantId}` — aborts the active turn |
| `POST /starhub/api/assistant/close` | `{assistantId}` — disposes agent + session |
| `POST /starhub/api/assistant/model` | `{assistantId, provider, model}` — per-assistant route override |
| `POST /starhub/api/assistant/approval` | `{assistantId, requestId, outcome}` — settles a parked approval |
| `GET /starhub/api/assistant/models` | provider/model catalog for the panel picker |
| `GET /starhub/api/assistant/stream?assistantId=` | SSE frame stream |

## Verification prompts belong to the terminal page (v0.140.0)

MFA codes, bastion machine selection, and host-key confirmations are interactive
steps on the user's own connection, so the panel no longer renders connection
cards and the shell's `StarHubConnCard` is retired: the terminal page serves
those prompts exactly as it did before the assistant existed. The assistant
simply waits for the tool result; if the terminal is not connected yet, the
result tells the user to connect and the assistant relays that.

## Model Experience

- Each assistant adds one root agent session per open SSH terminal page. Sessions live in the dsh session store (visible in the shell's session list) and are disposed when the page closes or the plugin unloads.
- The persona section (`starhub-ssh-assistant`, order 5) is registered inside the agent scope only; the deployment's system prompt is unchanged for every other agent.
- The tool restriction is an allow-list intersection: the assistant sees exactly the eight SSH/SFTP tools and nothing else — no local `bash`/`fs` tools, no database, browser, Android, or subagent tools.
- Requests use the deployment default provider/model unless the panel overrides the route; an override drops a stale reasoning effort so the new model resolves its own default.
- Approval asks are logged on the assistant session by `dsh-user-approval` as usual; the panel is one answerer in the waterfall, not a policy owner.
- AI command executions on the user's terminal session are broadcast as `ssh:exec-done` (sessionId = the terminal session id) and surface in the shell's SSH execution records view.

## Composition

Requires `agents`, `webServer`, `tools` (service names) and, at assistant-open time, the `sdk-transport` service (`starhub-bridge`) plus a configured default model. Wired into `examples/starhub-desktop/cordis.patch.yml` and `scripts/provision-dsh.mjs` (`STARHUB_PACKAGES`).

## Known Limitations and Deferred Work

- The model picker lists registered provider routes only; routes configured but not registered (no credential) do not appear.
- One assistant per terminal page: two pages on the same asset run two independent assistant sessions.
- With several terminal windows connected on one asset, commands land on the first live session (deterministic by session id); there is no per-command window selection.
