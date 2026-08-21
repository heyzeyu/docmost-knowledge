"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const pluginRoot = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(pluginRoot, relativePath), "utf8"),
  );
}

test("plugin and package versions stay aligned", () => {
  const manifest = readJson(".codex-plugin/plugin.json");
  const packageJson = readJson("package.json");

  assert.equal(manifest.name, "docmost-knowledge");
  assert.equal(manifest.version, "0.7.0");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.ok(manifest.interface.defaultPrompt.length <= 3);

  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/SKILL.md"),
    "utf8",
  );
  const doctor = fs.readFileSync(
    path.join(pluginRoot, "scripts/doctor.cjs"),
    "utf8",
  );
  assert.ok(skill.includes(`version \`${manifest.version}\``));
  assert.match(doctor, new RegExp(`Docmost MCP ${manifest.version}`));
});

test("mutation guidance distinguishes exact retries from changed requests", () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/SKILL.md"),
    "utf8",
  );
  const operations = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/references/operations.md"),
    "utf8",
  );

  assert.match(skill, /unchanged\s+arguments/);
  assert.match(skill, /read the page back in Markdown/);
  assert.match(operations, /new `expectedUpdatedAt`/);
  assert.match(operations, /new idempotency key/);
  assert.match(operations, /do not silently create at the\s+space root/);
});

test("template guidance covers discovery, preview, and destructive safety", () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/SKILL.md"),
    "utf8",
  );
  const operations = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/references/operations.md"),
    "utf8",
  );

  assert.match(skill, /`list_templates`/);
  assert.match(skill, /`render_template`/);
  assert.match(skill, /`instantiate_template`/);
  assert.match(operations, /immutable published version/);
  assert.match(operations, /`archive_template` or `delete_template`/);
  assert.match(operations, /must never be retried\s+automatically/);
});

test("page hierarchy guidance requires previewed and atomic moves", () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/SKILL.md"),
    "utf8",
  );
  const operations = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/references/operations.md"),
    "utf8",
  );

  assert.match(skill, /`get_page_tree`/);
  assert.match(skill, /`preview_page_move`/);
  assert.match(skill, /`move_pages` always requires\s+confirmation/);
  assert.match(operations, /never\s+calculate or send a fractional `position`/);
  assert.match(operations, /roll back the whole\s+batch/);
  assert.match(operations, /Do not request a vector reindex solely/);
});

test("Catalog guidance requires live freshness and tuple-bound cache reuse", () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/SKILL.md"),
    "utf8",
  );
  const operations = fs.readFileSync(
    path.join(pluginRoot, "skills/docmost-knowledge/references/operations.md"),
    "utf8",
  );

  assert.match(skill, /fresh[\s\S]*challenge/);
  assert.match(skill, /`resolve_catalog_bundle`/);
  assert.match(skill, /`resolve_catalog_delta`/);
  assert.match(operations, /\(page_id, updated_at, content_sha256\)/);
  assert.match(operations, /must not read Catalog/i);
  assert.match(operations, /never\s+reuse runtime\s+facts/i);
});

test("MCP manifest points to existing scripts with sufficient timeout", () => {
  const mcpManifest = readJson(".mcp.json");
  const server = mcpManifest.mcpServers["docmost-knowledge"];

  assert.equal(server.command, "node");
  assert.ok(server.tool_timeout_sec >= 120);
  for (const script of server.args) {
    assert.equal(fs.existsSync(path.join(pluginRoot, script)), true);
  }
});

test("Catalog v2 and v3 JSON Schemas are bundled with immutable version IDs", () => {
  const expected = new Map([
    ["catalog-bundle.v2.schema.json", "catalog-bundle.v2.schema.json"],
    ["catalog-delta.v2.schema.json", "catalog-delta.v2.schema.json"],
    [
      "catalog-freshness-proof.v2.schema.json",
      "catalog-freshness-proof.v2.schema.json",
    ],
    [
      "catalog-resolution-ticket.v1.schema.json",
      "catalog-resolution-ticket.v1.schema.json",
    ],
    ["catalog-bundle.v3.schema.json", "catalog-bundle.v3.schema.json"],
    ["catalog-delta.v3.schema.json", "catalog-delta.v3.schema.json"],
    [
      "catalog-freshness-proof.v3.schema.json",
      "catalog-freshness-proof.v3.schema.json",
    ],
  ]);

  for (const [file, schemaId] of expected) {
    const schema = readJson(`schemas/${file}`);
    assert.equal(schema.$id, schemaId);
    assert.equal(schema.additionalProperties, false);
  }
});

test("WorkBuddy manifest uses a portable plugin-root MCP path", () => {
  const manifest = readJson(".codebuddy-plugin/plugin.json");
  const packageJson = readJson("package.json");
  const mcpManifest = readJson(".workbuddy-mcp.json");
  const server = mcpManifest.mcpServers["docmost-knowledge"];

  assert.equal(manifest.name, "docmost-knowledge");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.workbuddy-mcp.json");
  assert.equal(server.command, "${CODEBUDDY_PLUGIN_ROOT}/scripts/run-node");
  assert.deepEqual(server.args, [
    "${CODEBUDDY_PLUGIN_ROOT}/scripts/docmost-keychain-proxy.cjs",
  ]);
  assert.equal(
    fs.existsSync(path.join(pluginRoot, "scripts/docmost-keychain-proxy.cjs")),
    true,
  );
  assert.equal(fs.existsSync(path.join(pluginRoot, "scripts/run-node")), true);
});

test(
  "installed distribution runs the full suite without repository parents",
  { skip: process.env.DOCMOST_INSTALL_LAYOUT_CHILD === "1" },
  () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "docmost-knowledge-installed-"),
    );
    const installedRoot = path.join(temporaryRoot, "docmost-knowledge");
    try {
      fs.cpSync(pluginRoot, installedRoot, { recursive: true });
      const tests = fs
        .readdirSync(path.join(installedRoot, "tests"))
        .filter((file) => file.endsWith(".test.cjs"))
        .sort()
        .map((file) => path.join("tests", file));
      const result = spawnSync(process.execPath, ["--test", ...tests], {
        cwd: installedRoot,
        encoding: "utf8",
        env: { ...process.env, DOCMOST_INSTALL_LAYOUT_CHILD: "1" },
      });
      assert.equal(
        result.status,
        0,
        [result.stdout, result.stderr].filter(Boolean).join("\n"),
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test("plugin source contains no unfinished placeholders", () => {
  const files = [
    ".codex-plugin/plugin.json",
    ".codebuddy-plugin/plugin.json",
    ".mcp.json",
    ".workbuddy-mcp.json",
    "package.json",
    "skills/docmost-knowledge/SKILL.md",
  ];
  for (const file of files) {
    const content = fs.readFileSync(path.join(pluginRoot, file), "utf8");
    assert.doesNotMatch(content, /\[TODO:|REPLACE_ME/);
  }
});
