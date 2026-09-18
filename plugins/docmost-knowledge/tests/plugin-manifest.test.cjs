"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pluginRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(pluginRoot, relativePath), "utf8"),
  );
}

test("plugin and package versions stay aligned", () => {
  const manifest = readJson(".codex-plugin/plugin.json");
  const packageJson = readJson("package.json");

  assert.equal(manifest.name, "docmost-knowledge");
  assert.equal(manifest.version, "0.6.1");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(typeof manifest.mcpServers, "object");
  assert.ok(manifest.interface.defaultPrompt.length <= 3);
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

  assert.match(skill, /fresh challenge/);
  assert.match(skill, /`resolve_catalog_bundle`/);
  assert.match(skill, /`resolve_catalog_delta`/);
  assert.match(operations, /\(page_id, updated_at, content_sha256\)/);
  assert.match(operations, /must not read Catalog/i);
  assert.match(operations, /never reuse runtime\s+facts/i);
});

test("Codex MCP manifest points to existing scripts with sufficient timeout", () => {
  const manifest = readJson(".codex-plugin/plugin.json");
  const server = manifest.mcpServers["docmost-knowledge"];

  assert.equal(server.command, "node");
  // Codex resolves the relative args against `cwd`, which it sets to the
  // plugin root; without it the proxy is looked up in the caller's directory.
  assert.equal(server.cwd, ".");
  assert.ok(server.tool_timeout_sec >= 120);
  for (const script of server.args) {
    assert.equal(fs.existsSync(path.join(pluginRoot, script)), true);
  }
});

test("Catalog v2 JSON Schemas are bundled with immutable version IDs", () => {
  const expected = new Map([
    ["catalog-bundle.v2.schema.json", "catalog-bundle.v2.schema.json"],
    ["catalog-delta.v2.schema.json", "catalog-delta.v2.schema.json"],
    [
      "catalog-freshness-proof.v2.schema.json",
      "catalog-freshness-proof.v2.schema.json",
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
  const marketplace = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, ".codebuddy-plugin/marketplace.json"),
      "utf8",
    ),
  );
  const server = mcpManifest.mcpServers["docmost-knowledge"];
  const marketplacePlugin = marketplace.plugins.find(
    (plugin) => plugin.name === "docmost-knowledge",
  );

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
  assert.equal(marketplace.name, "open-context");
  assert.equal(marketplacePlugin.source, "./plugins/docmost-knowledge");
  assert.equal(marketplacePlugin.version, manifest.version);
});

test("Claude Code manifest uses a portable plugin-root MCP path", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  const packageJson = readJson("package.json");
  const mcpManifest = readJson(".claude-mcp.json");
  const marketplace = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, ".claude-plugin/marketplace.json"),
      "utf8",
    ),
  );
  const server = mcpManifest.mcpServers["docmost-knowledge"];
  const marketplacePlugin = marketplace.plugins.find(
    (plugin) => plugin.name === "docmost-knowledge",
  );

  assert.equal(manifest.name, "docmost-knowledge");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.claude-mcp.json");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, [
    "${CLAUDE_PLUGIN_ROOT}/scripts/docmost-keychain-proxy.cjs",
  ]);
  assert.equal(
    fs.existsSync(path.join(pluginRoot, "scripts/docmost-keychain-proxy.cjs")),
    true,
  );
  assert.equal(marketplace.name, "open-context");
  assert.equal(marketplacePlugin.source, "./plugins/docmost-knowledge");
  assert.equal(marketplacePlugin.version, manifest.version);
});

test("no plugin-root .mcp.json exists, because every host reads it", () => {
  const claudeManifest = readJson(".claude-plugin/plugin.json");
  const codexManifest = readJson(".codex-plugin/plugin.json");
  const codebuddyManifest = readJson(".codebuddy-plugin/plugin.json");
  const claudeServer = readJson(".claude-mcp.json").mcpServers[
    "docmost-knowledge"
  ];

  // A plugin-root .mcp.json is read by all three hosts on top of whatever
  // their own manifest declares: Claude Code registers the proxy a second
  // time, and CodeBuddy starts no server at all when the two sources collide
  // on a server name. Every host therefore declares its own config instead.
  assert.equal(fs.existsSync(path.join(pluginRoot, ".mcp.json")), false);
  assert.equal(claudeManifest.mcpServers, "./.claude-mcp.json");
  assert.equal(typeof codexManifest.mcpServers, "object");
  assert.equal(codebuddyManifest.mcpServers, "./.workbuddy-mcp.json");
  // Claude Code has no `cwd` and ignores Codex's timeout key.
  assert.doesNotMatch(JSON.stringify(claudeServer), /"cwd"|"tool_timeout_sec"/);
});

test("plugin source contains no unfinished placeholders", () => {
  const files = [
    ".claude-plugin/plugin.json",
    ".claude-mcp.json",
    ".codex-plugin/plugin.json",
    ".codebuddy-plugin/plugin.json",
    ".workbuddy-mcp.json",
    "package.json",
    "skills/docmost-knowledge/SKILL.md",
  ];
  for (const file of files) {
    const content = fs.readFileSync(path.join(pluginRoot, file), "utf8");
    assert.doesNotMatch(content, /\[TODO:|REPLACE_ME/);
  }
});
