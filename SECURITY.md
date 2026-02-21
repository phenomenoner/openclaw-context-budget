# SECURITY

## Trust model

OpenClaw plugins execute in-process with gateway privileges. Treat this plugin as trusted code and review before deployment.

## Data handling

- The plugin does **not** exfiltrate data.
- It writes archived tool output to local filesystem only (`outDir`).
- Archived output can include sensitive command/file content from `exec` and `read`.

## Filesystem permissions

The plugin attempts secure defaults when writing archives:

- directories: `0700`
- files: `0600`

Operationally, also ensure parent directories and host mount policies are private.

## Secret minimization

- No remote calls.
- No third-party runtime dependencies.
- No credentials are required.

## Recommended operator controls

1. Keep `cronOnly=true` unless broader scope is required.
2. Keep `toolAllowlist` narrow.
3. Rotate/clean archive directory if retention policy demands.
   - Optional built-in retention: set `maxFilesPerSession` (>0) to prune oldest archived files per session directory.
4. Restrict access to `/tmp/openclaw/context-budget` (or custom `outDir`).

## Reporting

If you find a security issue, open a private report to the maintainer before public disclosure.
