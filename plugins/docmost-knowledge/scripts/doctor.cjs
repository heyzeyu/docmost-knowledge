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
  const keyIds = Object.keys(config.catalogPublicKeys ?? {}).sort();
  const pinCount = keyIds.length;

  process.stdout.write(
    `Profile: ${config.profileName}\nEndpoint: ${config.remoteUrl}\nTools: ${report.toolCount}\n`,
  );
  process.stdout.write(
    `Docmost MCP 0.7.0 core contract: ${
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
  process.stdout.write(
    report.catalogV3.compatible
      ? "Catalog v3 ticketed Bundle/Delta: compatible\n"
      : report.catalogV3.supported
        ? "Catalog v3 ticketed Bundle/Delta: incompatible\n"
        : "Catalog v3 ticketed Bundle/Delta: unsupported by this server (core tools remain usable)\n",
  );
  process.stdout.write(
    `Catalog signing pins: pinCount=${pinCount}; keyIds=${
      keyIds.length > 0 ? keyIds.join(",") : "none"
    }\n`,
  );
  const pinsRequired = report.catalogV2.supported || report.catalogV3.supported;
  if (!report.compatible || (pinsRequired && pinCount === 0)) {
    const details = formatContractReport(report);
    const pinIssue =
      pinsRequired && pinCount === 0
        ? "Catalog v2/v3 requires profile catalogPublicKeys pins"
        : "";
    const combined = [details, pinIssue].filter(Boolean).join("; ");
    if (!warnOnly) {
      throw new Error(`Docmost MCP 0.7.0 contract check failed: ${combined}`);
    }
    process.stdout.write(`Contract warnings: ${combined}\n`);
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Docmost Knowledge doctor failed";
  process.stderr.write(`${message.slice(0, 1000)}\n`);
  process.exitCode = 1;
});
