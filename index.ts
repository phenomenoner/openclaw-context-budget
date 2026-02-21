import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type ContextBudgetConfig = {
  enabled: boolean;
  cronOnly: boolean;
  toolAllowlist: string[];
  maxChars: number;
  maxLines: number;
  tailLines: number;
  outDir: string;
};

const DEFAULT_CONFIG: ContextBudgetConfig = {
  enabled: true,
  cronOnly: true,
  toolAllowlist: ["exec", "read"],
  maxChars: 40_000,
  maxLines: 200,
  tailLines: 80,
  outDir: "/tmp/openclaw/context-budget",
};

const MARKER = "[openclaw-context-budget]";

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const arr = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return arr.length > 0 ? arr : [];
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
  const cleaned = value.replace(/[^a-zA-Z0-9:._-]/g, "_").replace(/_+/g, "_").slice(0, 120);
  return cleaned || fallback;
}

function buildArchivePath(params: {
  outDir: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
  text: string;
}): string {
  const sessionSegment = sanitizePathSegment(params.sessionKey ?? "unknown-session", "unknown-session");
  const toolSegment = sanitizePathSegment(params.toolName ?? "unknown-tool", "unknown-tool");
  const callSegment = sanitizePathSegment(params.toolCallId ?? "no-call-id", "no-call-id");
  const hash = createHash("sha256").update(params.text).digest("hex").slice(0, 12);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${ts}-${toolSegment}-${callSegment}-${hash}.txt`;
  return path.join(params.outDir, sessionSegment, fileName);
}

function makeTailSnippet(text: string, maxChars: number, tailLines: number): string {
  const lines = splitLines(text);
  const tail = lines.slice(-Math.max(1, tailLines)).join("\n");
  if (tail.length <= maxChars) return tail;
  return tail.slice(-maxChars);
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
  if (cfg.toolAllowlist.length > 0 && !cfg.toolAllowlist.includes(toolName)) {
    return false;
  }

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

      const archivePath = buildArchivePath({
        outDir: cfg.outDir,
        sessionKey: ctx.sessionKey,
        toolName: resolvedToolName,
        toolCallId: event.toolCallId,
        text: fullText,
      });

      try {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true, mode: 0o700 });
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

      const snippet = makeTailSnippet(fullText, cfg.maxChars, cfg.tailLines);
      const snippetLines = splitLines(snippet).length;
      const pointerLine = fs.existsSync(archivePath)
        ? `Full output saved to: ${archivePath}`
        : "Full output could not be archived (see gateway logs).";

      const replacementText = [
        `${MARKER} Tool result truncated before session persistence.`,
        `Original size: ${charCount} chars / ${lineCount} lines. Caps: ${cfg.maxChars} chars / ${cfg.maxLines} lines.`,
        pointerLine,
        `Snippet shown: tail ${snippet.length} chars / ${snippetLines} lines (tailLines=${cfg.tailLines}).`,
        "",
        snippet,
      ].join("\n");

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
          },
        },
      };

      return { message: nextMessage as typeof event.message };
    },
    { priority: 1000 },
  );
}
