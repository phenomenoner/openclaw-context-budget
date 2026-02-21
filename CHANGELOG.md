# CHANGELOG

## 0.1.1 - 2026-02-21

Refinement pass after review.

- Hardened archive path construction against path traversal by removing dots/colons in path segments and verifying resolved paths stay under `outDir`.
- Added optional retention safety: `maxFilesPerSession` (0 = unlimited; best-effort prune oldest files per session directory).
- Made persisted replacement text respect context budget more strictly (header + snippet sized to stay within caps).
- Clarified allowlist semantics: empty `toolAllowlist` matches nothing.

## 0.1.0 - 2026-02-21

Initial MVP release.

- Added OpenClaw plugin `openclaw-context-budget`.
- Implemented synchronous `tool_result_persist` guard.
- Enforced configurable caps (`maxChars`, `maxLines`, `tailLines`) with tail-preferred truncation.
- Archived full oversized tool output to `outDir` with session-scoped paths.
- Default scope: cron sessions only (`:cron:`) and `exec`/`read` tool names only.
- Added docs: README, DESIGN, SECURITY, local install guide.
