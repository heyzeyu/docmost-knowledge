#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  analyzeToolCatalog,
  formatContractReport,
} = require("./tool-contract.cjs");

const proxyPath = path.join(__dirname, "docmost-keychain-proxy.cjs");
const warnOnly = process.argv.includes("--warn");
const child = spawn(process.execPath, [proxyPath], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let completed = false;

function finish(error) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  child.kill();
  if (error) {
    process.stderr.write(
      `Docmost MCP live smoke failed${
        stderr.trim() ? `: ${stderr.trim()}` : ""
      }\n`,
    );
    process.exitCode = 1;
    return;
  }

  let responses;
  try {
    responses = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    process.stderr.write("Docmost MCP live smoke returned invalid JSON\n");
    process.exitCode = 1;
    return;
  }

  const initialized = responses.find((response) => response.id === 1);
  const listed = responses.find((response) => response.id === 2);
  if (
    initialized?.result?.serverInfo?.name !== "docmost-knowledge" ||
    !Array.isArray(listed?.result?.tools)
  ) {
    process.stderr.write("Docmost MCP live smoke returned invalid responses\n");
    process.exitCode = 1;
    return;
  }

  const report = analyzeToolCatalog(listed.result.tools);
  if (!report.compatible && !warnOnly) {
    process.stderr.write(
      `Docmost MCP 0.7.0 contract check failed: ${formatContractReport(report)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Docmost MCP live smoke passed: ${report.toolCount} tools available, profile contract ${
      report.compatible ? "compatible" : "has warnings"
    }.\n`,
  );
  process.stdout.write(
    report.catalogV3.compatible
      ? "Catalog v3 ticketed Bundle/Delta: compatible.\n"
      : report.catalogV3.supported
        ? "Catalog v3 ticketed Bundle/Delta: incompatible.\n"
        : "Catalog v3 ticketed Bundle/Delta: unsupported by this server; core tools remain usable.\n",
  );
  process.stdout.write(
    report.catalog.compatible
      ? "Catalog v1 Bundle/Freshness: compatible.\n"
      : report.catalog.supported
        ? "Catalog v1 Bundle/Freshness: incompatible.\n"
        : "Catalog v1 Bundle/Freshness: unsupported by this server.\n",
  );
  process.stdout.write(
    report.catalogV2.compatible
      ? "Catalog v2 signed Bundle/Delta: compatible.\n"
      : report.catalogV2.supported
        ? "Catalog v2 signed Bundle/Delta: incompatible.\n"
        : "Catalog v2 signed Bundle/Delta: unsupported by this server; core tools remain usable.\n",
  );
  if (!report.compatible) {
    process.stdout.write(`${formatContractReport(report)}\n`);
  }
}

const timeout = setTimeout(() => finish(new Error("timeout")), 120_000);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  if ((stdout.match(/\n/g) || []).length >= 2) {
    finish();
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", finish);
child.on("exit", (code) => {
  if (!completed && code !== 0) {
    finish(new Error(`proxy exited with ${code}`));
  }
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  })}\n`,
);
child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })}\n`,
);
