#!/usr/bin/env node
"use strict";

const {
  callRemote,
  getConfig,
  resolveToken,
} = require("./docmost-keychain-proxy.cjs");
const {
  analyzeToolCatalog,
  formatContractReport,
} = require("./tool-contract.cjs");

async function main() {
  const warnOnly = process.argv.includes("--warn");
  const config = getConfig();
  const token = resolveToken(config);
  const result = await callRemote(config, token, "tools/list", {});
  const report = analyzeToolCatalog(result.tools);

  process.stdout.write(
    `Profile: ${config.profileName}\nEndpoint: ${config.remoteUrl}\nTools: ${report.toolCount}\n`,
  );
  process.stdout.write(
    `Docmost MCP v0.6 core contract: ${
      report.coreCompatible ? "compatible" : "incompatible"
    }\n`,
  );
  process.stdout.write(
    report.catalog.compatible
      ? "Catalog v1 Bundle/Freshness: compatible\n"
      : report.catalog.supported
        ? "Catalog v1 Bundle/Freshness: incompatible\n"
        : "Catalog v1 Bundle/Freshness: unsupported by this server (optional legacy capability)\n",
  );
  process.stdout.write(
    report.catalogV2.compatible
      ? "Catalog v2 signed Bundle/Delta: compatible\n"
      : report.catalogV2.supported
        ? "Catalog v2 signed Bundle/Delta: incompatible\n"
        : "Catalog v2 signed Bundle/Delta: unsupported by this server (core tools remain usable)\n",
  );
  if (!report.compatible) {
    const details = formatContractReport(report);
    if (!warnOnly) {
      throw new Error(`Docmost MCP v0.6 contract check failed: ${details}`);
    }
    process.stdout.write(`Contract warnings: ${details}\n`);
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Docmost Knowledge doctor failed";
  process.stderr.write(`${message.slice(0, 1000)}\n`);
  process.exitCode = 1;
});
