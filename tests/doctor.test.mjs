import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { evaluateDoctor, resolvePluginConfig, readJsoncFile } from "../scripts/doctor.mjs";

test("resolvePluginConfig clamps tailLines and preserves empty allowlist", () => {
  const cfg = resolvePluginConfig({ maxLines: 50, tailLines: 200, toolAllowlist: [] });
  assert.equal(cfg.maxLines, 50);
  assert.equal(cfg.tailLines, 50);
  assert.deepEqual(cfg.toolAllowlist, []);
});

test("readJsoncFile parses json with comments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-jsonc-"));
  const file = path.join(dir, "openclaw.json");
  fs.writeFileSync(
    file,
    `// comment
{
  /* block */
  "plugins": {"entries": {"openclaw-context-budget": {"enabled": true}}}
}`,
  );
  const obj = readJsoncFile(file);
  assert.equal(obj.plugins.entries["openclaw-context-budget"].enabled, true);
});

test("evaluateDoctor warns when plugin entry missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-repo-"));
  fs.writeFileSync(path.join(dir, "index.ts"), "export default {};\n");
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  const payload = evaluateDoctor({
    configPath: "/tmp/fake-openclaw.json",
    configObj: { plugins: { entries: {} } },
    repoRoot: dir,
  });
  assert.equal(payload.kind, "openclaw-context-budget.doctor.v0");
  assert.equal(payload.ok, true);
  const missingEntry = payload.checks.find((item) => item.name === "plugin.entry.present");
  assert.ok(missingEntry);
  assert.equal(missingEntry.ok, false);
  assert.equal(missingEntry.severity, "warn");
});

test("evaluateDoctor keeps valid cap contract after normalization", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-repo-"));
  fs.writeFileSync(path.join(dir, "index.ts"), "export default {};\n");
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  const payload = evaluateDoctor({
    configPath: "/tmp/fake-openclaw.json",
    configObj: {
      plugins: {
        entries: {
          "openclaw-context-budget": {
            enabled: true,
            config: { maxLines: 10, tailLines: 999, toolAllowlist: ["exec"] },
          },
        },
      },
    },
    repoRoot: dir,
  });
  const caps = payload.checks.find((item) => item.name === "plugin.config.caps");
  assert.ok(caps);
  assert.equal(caps.ok, true);
  assert.equal(payload.summary.entryEnabled, true);
});
