# Install on this machine (local recipe)

> This guide is intentionally manual. It does **not** auto-modify your gateway config.

## 1) Install plugin from local checkout

From workspace root (`/root/.openclaw/workspace`):

```bash
openclaw plugins install -l ./openclaw-context-budget
```

## 2) Add config in `openclaw.json`

Add/merge:

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

## 3) Restart gateway

```bash
openclaw gateway restart
```

## 4) Verify

```bash
openclaw plugins list | grep openclaw-context-budget
openclaw plugins doctor
cd /root/.openclaw/workspace/openclaw-context-budget
npm run doctor -- --json
```

For a cron session that emits a huge `exec`/`read` result, you should see persisted transcript content replaced with a marker + file pointer, with full output archived under:

```text
/tmp/openclaw/context-budget/<sessionKey>/
```
