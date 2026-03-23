import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type ContextBudgetConfig = {
  enabled: boolean;
  cronOnly: boolean;
  toolAllowlist: string[];
  maxChars: number;
  maxLines: number;
  tailLines: number;
  outDir: string;
  /**
   * Optional retention safety: max archived files per session directory.
   * 0 means unlimited (default).
   */
  maxFilesPerSession: number;
};

const DEFAULT_CONFIG: ContextBudgetConfig = {
  enabled: true,
  cronOnly: true,
  toolAllowlist: ["exec", "read"],
  maxChars: 40_000,
  maxLines: 200,
  tailLines: 80,
  outDir: "/tmp/openclaw/context-budget",
  maxFilesPerSession: 0,
};

const MARKER = "[openclaw-context-budget]";

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value);
  return parsed >= 0 ? parsed : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * If the user explicitly provides an array (including empty), respect it.
 * If missing or not an array, use fallback.
 */
function asStringArray(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function resolveConfig(input: unknown): ContextBudgetConfig {
  const cfg = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
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

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractTextPayload(message: Record<string, unknown>): string {
  const chunks: string[] = [];

  const content = message.content;
  if (typeof content === "string") {
    chunks.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const entry = block as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") {
        chunks.push(entry.text);
      }
    }
  } else if (content !== undefined) {
    chunks.push(safeStringify(content));
  }

  if (message.details !== undefined) {
    const detailsText =
      typeof message.details === "string" ? message.details : safeStringify(message.details);
    chunks.push(`[details]\n${detailsText}`);
  }

  if (chunks.length === 0) {
    chunks.push(safeStringify(message));
  }

  return chunks.join("\n\n");
}

function sanitizePathSegment(value: string, fallback: string): string {
  // Keep it simple and portable: avoid ':' and '.' to reduce oddities across filesystems.
  let cleaned = value
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);

  if (!cleaned) cleaned = fallback;

  // Extra guardrails against path traversal semantics.
  if (cleaned === "." || cleaned === "..") cleaned = fallback;

  return cleaned;
}

function buildArchivePath(params: {
  outDir: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
  text: string;
}): { archivePath: string; sessionDir: string } {
  const outRoot = path.resolve(params.outDir);

  const sessionSegment = sanitizePathSegment(params.sessionKey ?? "unknown-session", "unknown-session");
  const toolSegment = sanitizePathSegment(params.toolName ?? "unknown-tool", "unknown-tool");
  const callSegment = sanitizePathSegment(params.toolCallId ?? "no-call-id", "no-call-id");

  const hash = createHash("sha256").update(params.text).digest("hex").slice(0, 12);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${ts}-${toolSegment}-${callSegment}-${hash}.txt`;

  // Resolve and assert the target stays under outRoot.
  const sessionDir = path.resolve(outRoot, sessionSegment);
  const archivePath = path.resolve(sessionDir, fileName);
  const outRootPrefix = outRoot.endsWith(path.sep) ? outRoot : outRoot + path.sep;
  if (!archivePath.startsWith(outRootPrefix)) {
    // Extremely defensive fallback.
    const safeSessionDir = path.resolve(outRoot, "unknown-session");
    return {
      sessionDir: safeSessionDir,
      archivePath: path.resolve(safeSessionDir, fileName),
    };
  }

  return { sessionDir, archivePath };
}

function makeTailSnippet(params: { text: string; maxChars: number; tailLines: number }): string {
  const lines = splitLines(params.text);
  const tail = lines.slice(-Math.max(1, params.tailLines)).join("\n");
  if (tail.length <= params.maxChars) return tail;
  return tail.slice(-params.maxChars);
}

function enforceMaxFilesPerSession(params: {
  sessionDir: string;
  maxFilesPerSession: number;
  logger: OpenClawPluginApi["logger"];
}): void {
  const { sessionDir, maxFilesPerSession, logger } = params;
  if (!maxFilesPerSession || maxFilesPerSession <= 0) return;

  try {
    const entries = fs
      .readdirSync(sessionDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".txt"))
      .map((e) => {
        const p = path.join(sessionDir, e.name);
        const st = fs.statSync(p);
        return { path: p, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const excess = entries.length - maxFilesPerSession;
    if (excess <= 0) return;

    for (const item of entries.slice(0, excess)) {
      try {
        fs.unlinkSync(item.path);
      } catch {
        // Best-effort.
      }
    }

    logger.warn(
      `${MARKER} retention: pruned ${excess} archived files under ${sessionDir} (maxFilesPerSession=${maxFilesPerSession}).`,
    );
  } catch {
    // Best-effort.
  }
}

function shouldHandle(params: {
  cfg: ContextBudgetConfig;
  sessionKey?: string;
  toolName?: string;
  message?: Record<string, unknown>;
}): boolean {
  const { cfg, sessionKey, toolName, message } = params;
  if (!cfg.enabled) return false;

  if (cfg.cronOnly && !(sessionKey ?? "").includes(":cron:")) {
    return false;
  }

  if (!toolName) return false;

  // Explicit empty allowlist => match nothing (safer + less surprising).
  if (cfg.toolAllowlist.length === 0) return false;
  if (!cfg.toolAllowlist.includes(toolName)) return false;

  if (!message || message.role !== "toolResult") {
    return false;
  }

  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const entry = block as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string" && entry.text.includes(MARKER)) {
        return false;
      }
    }
  }

  return true;
}

export default function register(api: OpenClawPluginApi) {
  const cfg = resolveConfig(api.pluginConfig);

  api.on(
    "tool_result_persist",
    (event, ctx) => {
      const message =
        event.message && typeof event.message === "object"
          ? (event.message as Record<string, unknown>)
          : undefined;

      const resolvedToolName =
        (typeof event.toolName === "string" && event.toolName) ||
        (typeof ctx.toolName === "string" && ctx.toolName) ||
        (message && typeof message.toolName === "string" ? message.toolName : undefined);

      if (
        !shouldHandle({
          cfg,
          sessionKey: ctx.sessionKey,
          toolName: resolvedToolName,
          message,
        })
      ) {
        return;
      }

      if (!message) {
        return;
      }

      const fullText = extractTextPayload(message);
      const lineCount = splitLines(fullText).length;
      const charCount = fullText.length;

      const overChars = charCount > cfg.maxChars;
      const overLines = lineCount > cfg.maxLines;
      if (!overChars && !overLines) {
        return;
      }

      const { sessionDir, archivePath } = buildArchivePath({
        outDir: cfg.outDir,
        sessionKey: ctx.sessionKey,
        toolName: resolvedToolName,
        toolCallId: event.toolCallId,
        text: fullText,
      });

      try {
        fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

        // Retention is best-effort and runs before writing the new file.
        enforceMaxFilesPerSession({
          sessionDir,
          maxFilesPerSession: cfg.maxFilesPerSession,
          logger: api.logger,
        });

        const archiveHeader = [
          "# openclaw-context-budget archive",
          `timestamp: ${new Date().toISOString()}`,
          `sessionKey: ${ctx.sessionKey ?? "unknown"}`,
          `toolName: ${resolvedToolName ?? "unknown"}`,
          `toolCallId: ${event.toolCallId ?? "unknown"}`,
          `chars: ${charCount}`,
          `lines: ${lineCount}`,
          "",
        ].join("\n");

        fs.writeFileSync(archivePath, `${archiveHeader}${fullText}\n`, {
          encoding: "utf-8",
          mode: 0o600,
        });
      } catch (error) {
        api.logger.warn(
          `${MARKER} failed to archive full tool result to disk (${String(error)}); applying truncation without archive pointer.`,
        );
      }

      const pointerLine = fs.existsSync(archivePath)
        ? `Full output saved to: ${archivePath}`
        : "Full output could not be archived (see gateway logs).";

      const headerLines = [
        `${MARKER} Tool result truncated before session persistence.`,
        `Original size: ${charCount} chars / ${lineCount} lines. Caps: ${cfg.maxChars} chars / ${cfg.maxLines} lines.`,
        pointerLine,
        `Snippet shown: tail (tailLines<=${cfg.tailLines}).`,
      ];

      const header = headerLines.join("\n");
      const headerLineCount = headerLines.length;

      // Ensure persisted message stays within (approx) cfg.maxChars/cfg.maxLines.
      const snippetMaxChars = Math.max(500, cfg.maxChars - header.length - 2);
      const snippetTailLines = Math.max(1, Math.min(cfg.tailLines, cfg.maxLines - headerLineCount - 2));

      const snippet = makeTailSnippet({
        text: fullText,
        maxChars: snippetMaxChars,
        tailLines: snippetTailLines,
      });

      const replacementText = `${header}\n\n${snippet}`;

      const nextMessage: Record<string, unknown> = {
        ...message,
        content: [{ type: "text", text: replacementText }],
        details: {
          contextBudget: {
            archivedPath: fs.existsSync(archivePath) ? archivePath : null,
            originalChars: charCount,
            originalLines: lineCount,
            maxChars: cfg.maxChars,
            maxLines: cfg.maxLines,
            tailLines: cfg.tailLines,
            maxFilesPerSession: cfg.maxFilesPerSession,
          },
        },
      };

      return { message: nextMessage as typeof event.message };
    },
    { priority: 1000 },
  );
}
