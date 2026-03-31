#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = {
  enabled: true,
  cronOnly: true,
  toolAllowlist: ["exec", "read"],
  maxChars: 40_000,
  maxLines: 200,
  tailLines: 80,
  outDir: "/tmp/openclaw/context-budget",
  maxFilesPerSession: 0,
};

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function resolveOpenClawConfigPath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.OPENCLAW_CONFIG_PATH) return path.resolve(process.env.OPENCLAW_CONFIG_PATH);
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

export function readJsoncFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(stripJsonComments(raw));
}

function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function asPositiveInt(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function asNonNegativeInt(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value);
  return parsed >= 0 ? parsed : fallback;
}

function asStringArray(value, fallback) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return fallback;
  return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

export function resolvePluginConfig(input) {
  const cfg = input && typeof input === "object" ? input : {};
  const maxChars = asPositiveInt(cfg.maxChars, DEFAULT_CONFIG.maxChars);
  const maxLines = asPositiveInt(cfg.maxLines, DEFAULT_CONFIG.maxLines);
  const tailLines = Math.min(asPositiveInt(cfg.tailLines, DEFAULT_CONFIG.tailLines), maxLines);
  return {
    enabled: asBoolean(cfg.enabled, DEFAULT_CONFIG.enabled),
    cronOnly: asBoolean(cfg.cronOnly, DEFAULT_CONFIG.cronOnly),
    toolAllowlist: asStringArray(cfg.toolAllowlist, DEFAULT_CONFIG.toolAllowlist),
    maxChars,
    maxLines,
    tailLines,
    outDir: asString(cfg.outDir, DEFAULT_CONFIG.outDir),
    maxFilesPerSession: asNonNegativeInt(cfg.maxFilesPerSession, DEFAULT_CONFIG.maxFilesPerSession),
  };
}

export function pathStatus(targetPath) {
  const resolved = path.resolve(targetPath);
  const exists = fs.existsSync(resolved);
  const out = { path: resolved, exists };
  if (!exists) return out;
  const st = fs.statSync(resolved);
  out.isDirectory = st.isDirectory();
  out.isFile = st.isFile();
  out.mode = st.mode & 0o777;
  return out;
}

export function evaluateDoctor({ configPath, configObj, repoRoot }) {
  const checks = [];
  const add = (name, ok, severity, detail, extra = {}) => checks.push({ name, ok: !!ok, severity, detail, ...extra });

  const pluginEntry = configObj?.plugins?.entries?.["openclaw-context-budget"];
  const entryPresent = !!(pluginEntry && typeof pluginEntry === "object");
  const entryEnabled = entryPresent ? pluginEntry.enabled !== false : false;
  const pluginConfig = resolvePluginConfig(entryPresent ? pluginEntry.config : undefined);

  add(
    "openclaw.config",
    true,
    "info",
    "OpenClaw config is readable.",
    { path: configPath },
  );

  add(
    "plugin.entry.present",
    entryPresent,
    entryPresent ? "info" : "warn",
    entryPresent
      ? "Plugin entry exists in openclaw.json."
      : "Plugin entry is missing in openclaw.json; local repo may exist, but gateway config is not wired yet.",
  );

  add(
    "plugin.entry.enabled",
    entryEnabled,
    entryEnabled ? "info" : "warn",
    entryEnabled
      ? "Plugin entry is enabled."
      : "Plugin entry is disabled; install/config may be present but runtime guard is off.",
  );

  add(
    "plugin.config.enabled",
    pluginConfig.enabled,
    pluginConfig.enabled ? "info" : "warn",
    pluginConfig.enabled
      ? "Plugin config.enabled is true."
      : "Plugin config.enabled is false; runtime truncation is disabled even if the plugin entry is on.",
  );

  add(
    "plugin.config.allowlist",
    pluginConfig.toolAllowlist.length > 0,
    pluginConfig.toolAllowlist.length > 0 ? "info" : "warn",
    pluginConfig.toolAllowlist.length > 0
      ? "toolAllowlist is non-empty."
      : "toolAllowlist is empty; current posture matches nothing and truncation will never trigger.",
    { toolAllowlist: pluginConfig.toolAllowlist },
  );

  const capsOk = pluginConfig.maxChars > 0 && pluginConfig.maxLines > 0 && pluginConfig.tailLines > 0 && pluginConfig.tailLines <= pluginConfig.maxLines;
  add(
    "plugin.config.caps",
    capsOk,
    capsOk ? "info" : "error",
    capsOk
      ? "maxChars/maxLines/tailLines form a valid bounded truncation contract."
      : "Invalid cap configuration; expected positive maxChars/maxLines and tailLines <= maxLines.",
    {
      maxChars: pluginConfig.maxChars,
      maxLines: pluginConfig.maxLines,
      tailLines: pluginConfig.tailLines,
      maxFilesPerSession: pluginConfig.maxFilesPerSession,
    },
  );

  const outDirResolved = path.resolve(pluginConfig.outDir);
  const outDirExists = fs.existsSync(outDirResolved);
  const outDirParent = outDirExists ? outDirResolved : path.dirname(outDirResolved);
  let parentWritable = false;
  try {
    fs.accessSync(outDirParent, fs.constants.W_OK);
    parentWritable = true;
  } catch {
    parentWritable = false;
  }
  add(
    "plugin.config.outDir",
    path.isAbsolute(pluginConfig.outDir) && parentWritable,
    path.isAbsolute(pluginConfig.outDir) && parentWritable ? "info" : "warn",
    path.isAbsolute(pluginConfig.outDir) && parentWritable
      ? (outDirExists ? "Archive outDir exists and looks writable." : "Archive outDir does not exist yet, but parent path looks writable.")
      : "Archive outDir is not absolute or parent path does not look writable.",
    {
      outDir: outDirResolved,
      exists: outDirExists,
      parent: outDirParent,
      parentWritable,
    },
  );

  const repoFiles = [
    path.join(repoRoot, "index.ts"),
    path.join(repoRoot, "openclaw.plugin.json"),
    path.join(repoRoot, "package.json"),
  ];
  const missingRepoFiles = repoFiles.filter((p) => !fs.existsSync(p)).map((p) => path.relative(repoRoot, p));
  add(
    "repo.surface",
    missingRepoFiles.length === 0,
    missingRepoFiles.length === 0 ? "info" : "warn",
    missingRepoFiles.length === 0
      ? "Local plugin repo has the expected runtime/package manifest files."
      : "Local plugin repo is missing one or more expected manifest/runtime files.",
    { missing: missingRepoFiles },
  );

  const errors = checks.filter((c) => c.severity === "error" && !c.ok).length;
  const warnings = checks.filter((c) => c.severity === "warn" && !c.ok).length;

  return {
    kind: "openclaw-context-budget.doctor.v0",
    ts: new Date().toISOString(),
    ok: errors === 0,
    summary: {
      errors,
      warnings,
      configPath,
      entryPresent,
      entryEnabled,
      configEnabled: pluginConfig.enabled,
      cronOnly: pluginConfig.cronOnly,
      outDir: outDirResolved,
    },
    config: pluginConfig,
    checks,
  };
}

export function runDoctor({ configPath, repoRoot }) {
  try {
    const resolvedConfig = resolveOpenClawConfigPath(configPath);
    const configObj = readJsoncFile(resolvedConfig);
    return evaluateDoctor({ configPath: resolvedConfig, configObj, repoRoot });
  } catch (error) {
    return {
      kind: "openclaw-context-budget.doctor.v0",
      ts: new Date().toISOString(),
      ok: false,
      summary: {
        errors: 1,
        warnings: 0,
        configPath: resolveOpenClawConfigPath(configPath),
      },
      checks: [
        {
          name: "openclaw.config",
          ok: false,
          severity: "error",
          detail: `Failed to read OpenClaw config: ${String(error?.message || error)}`,
        },
      ],
    };
  }
}

function renderText(payload) {
  const lines = [
    `openclaw-context-budget doctor: ok=${String(payload.ok).toLowerCase()} errors=${payload.summary?.errors ?? 0} warnings=${payload.summary?.warnings ?? 0}`,
    `config: ${payload.summary?.configPath ?? "(unknown)"}`,
    `outDir: ${payload.summary?.outDir ?? "(unknown)"}`,
  ];
  for (const item of payload.checks || []) {
    const status = item.ok ? "ok" : item.severity;
    lines.push(`- ${item.name}: ${status} — ${item.detail}`);
  }
  return lines.join("\\n");
}

function parseArgs(argv) {
  const out = { json: false, configPath: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") out.json = true;
    else if (token === "--config") {
      out.configPath = argv[i + 1];
      i += 1;
    } else if (token === "-h" || token === "--help") {
      console.log("Usage: node scripts/doctor.mjs [--json] [--config /path/to/openclaw.json]");
      process.exit(0);
    }
  }
  return out;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const args = parseArgs(process.argv.slice(2));
  const payload = runDoctor({
    configPath: args.configPath,
    repoRoot: path.resolve(path.dirname(thisFile), ".."),
  });
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(renderText(payload));
  process.exit(payload.ok ? 0 : 1);
}
