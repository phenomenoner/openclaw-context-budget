# openclaw-context-budget

Hard-enforce **progressive disclosure** in OpenClaw by truncating oversized tool results **before** they are persisted into session transcripts.

This is designed to protect high-volume automation flows (especially cron runs) from context blowups caused by very large `exec` / `read` outputs.

## What it does

The plugin registers the synchronous `tool_result_persist` hook and, when a matching tool result exceeds configured caps:

1. Writes the **full original text** to disk at:
   - `/tmp/openclaw/context-budget/<sessionKey>/...` (default root)
2. Replaces the persisted tool result with:
   - a short truncation notice,
   - a one-line pointer to the archived file,
   - a tail snippet (prefer tail) bounded by your caps.

## Default behavior (MVP)

- `enabled: true`
- `cronOnly: true` (session key must contain `:cron:`)
- `toolAllowlist: ["exec", "read"]`
- `maxChars: 40000`
- `maxLines: 200`
- `tailLines: 80`
- `outDir: /tmp/openclaw/context-budget`

So by default, it only guards cron-session `exec`/`read` results.

## Why this exists

Large tool outputs can dominate persisted transcripts and accelerate compaction/overflow in unattended lanes.

### How this fixes “A-fast overflow”

In fast cron loops, repeated large outputs can quickly saturate retained context and trigger aggressive compaction churn. This plugin enforces a hard ceiling at persistence time, so each oversized result is reduced to a bounded tail snippet while preserving full output on disk for audit/debug.

## Installation

### Option A — from local checkout

```bash
openclaw plugins install -l ./openclaw-context-budget
# restart gateway after install/config changes
openclaw gateway restart
```

### Option B — from npm (after publish)

```bash
openclaw plugins install openclaw-context-budget
openclaw gateway restart
```

## Configuration

Add under `plugins.entries.openclaw-context-budget.config` in `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-context-budget": {
        "enabled": true,
        "config": {
          "enabled": true,
          "cronOnly": true,
          "toolAllowlist": ["exec", "read"],
          "maxChars": 40000,
          "maxLines": 200,
          "tailLines": 80,
          "outDir": "/tmp/openclaw/context-budget"
        }
      }
    }
  }
}
```

Example to enable for all sessions and additional tools:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-context-budget": {
        "enabled": true,
        "config": {
          "cronOnly": false,
          "toolAllowlist": ["exec", "read", "web_fetch"],
          "maxChars": 25000,
          "maxLines": 150,
          "tailLines": 60
        }
      }
    }
  }
}
```

## Safety notes

- Runs in-process with gateway permissions; only install trusted plugin code.
- Uses synchronous filesystem writes inside a synchronous hook (intentionally) to guarantee archive+truncate behavior before persistence.
- Archives may contain sensitive tool output. Protect `outDir` and avoid world-readable paths.

See also:
- [DESIGN.md](./DESIGN.md)
- [SECURITY.md](./SECURITY.md)
- [docs/INSTALL_OPENCLAW.md](./docs/INSTALL_OPENCLAW.md)
