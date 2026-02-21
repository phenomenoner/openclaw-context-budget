# DESIGN

## Goal

Bound persisted tool-result payload size to enforce progressive disclosure without losing recoverability of full output.

## Hook choice

This plugin uses `tool_result_persist` because it runs **synchronously** on the persistence hot path, right before tool results are written into session transcript JSONL.

Why this hook:

- Earliest safe point to mutate persisted tool result payload.
- Prevents oversized payloads from ever entering transcript history.
- No async races (the hook is sync-only by design in OpenClaw).

## Scope model

Default scope is intentionally narrow:

- session key contains `:cron:` (`cronOnly=true`)
- tool name in `toolAllowlist` (`["exec","read"]`)

This targets the highest-risk unattended flows first.

## Truncation semantics

When either condition is exceeded:

- `chars > maxChars`
- `lines > maxLines`

the plugin:

1. Extracts textual payload from tool result (`content` text blocks + serialized `details`).
2. Writes full extracted text to archive file under:
   - `<outDir>/<sessionKey>/<timestamp>-<tool>-<call>-<hash>.txt`
3. Replaces persisted message content with:
   - truncation marker,
   - one-line archive pointer,
   - bounded **tail-preferred** snippet.

Tail strategy:

- keep the last `tailLines` lines,
- then enforce final `maxChars` cap by tail-chopping if needed.

This preserves the latest/error-relevant output while keeping transcript budgets stable.

## Failure modes

### Archive write failure

If write fails (permission/disk), the plugin still truncates persisted content and logs a warning. Pointer line reports archive failure.

### Malformed message payloads

If message/tool metadata is missing or not a `toolResult`, plugin is fail-open and returns `undefined` (no mutation).

### Duplicate processing

Plugin tags replacement text with `[openclaw-context-budget]` and skips reprocessing messages already marked.

## Performance

- Uses sync `mkdirSync`/`writeFileSync` intentionally (required by sync hook behavior).
- Only activates in configured scope.
- No external dependencies.
