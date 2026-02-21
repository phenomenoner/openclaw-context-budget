# CHANGELOG

## 0.1.0 - 2026-02-21

Initial MVP release.

- Added OpenClaw plugin `openclaw-context-budget`.
- Implemented synchronous `tool_result_persist` guard.
- Enforced configurable caps (`maxChars`, `maxLines`, `tailLines`) with tail-preferred truncation.
- Archived full oversized tool output to `outDir` with session-scoped paths.
- Default scope: cron sessions only (`:cron:`) and `exec`/`read` tool names only.
- Added docs: README, DESIGN, SECURITY, local install guide.
