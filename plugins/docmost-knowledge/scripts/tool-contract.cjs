"use strict";

const {
  CATALOG_TOOLS,
  MAX_PAGES: MAX_CATALOG_PAGES,
  MAX_ROOTS: MAX_CATALOG_ROOTS,
} = require("./catalog-bundle-contract.cjs");
const { CATALOG_V2_TOOLS } = require("./catalog-bundle-v2-contract.cjs");

const TEMPLATE_READ_TOOLS = Object.freeze([
  "list_templates",
  "get_template",
  "render_template",
]);

const TEMPLATE_MUTATION_TOOLS = Object.freeze([
  "instantiate_template",
  "create_template",
  "update_template",
  "publish_template",
  "archive_template",
  "delete_template",
]);

const CORE_REQUIRED_TOOLS = Object.freeze([
  "list_spaces",
  "list_pages",
  "get_page",
  "get_page_tree",
  "preview_page_move",
  "move_page",
  "move_pages",
  "list_page_versions",
  "get_page_version",
  "diff_page_versions",
  "restore_page_version",
  "list_attachments",
  "get_attachment",
  "upload_attachment",
  "delete_attachment",
  "search_docs",
  "semantic_search_docs",
  "create_page",
  "update_page",
  "append_page",
  "delete_page",
  "restore_page",
  "reindex_page",
  "reindex_space",
  "reindex_workspace",
  "get_index_status",
  "list_index_jobs",
  "retry_index_job",
  "pause_index_job",
  "resume_index_job",
  "cancel_index_job",
  ...TEMPLATE_READ_TOOLS,
  ...TEMPLATE_MUTATION_TOOLS,
]);
const REQUIRED_TOOLS = CORE_REQUIRED_TOOLS;

const MUTATION_TOOLS = new Set([
  "restore_page_version",
  "upload_attachment",
  "delete_attachment",
  "create_page",
  "update_page",
  "append_page",
  "move_page",
  "move_pages",
  "delete_page",
  "restore_page",
  "reindex_page",
  "reindex_space",
  "reindex_workspace",
  "retry_index_job",
  "pause_index_job",
  "resume_index_job",
  "cancel_index_job",
  ...TEMPLATE_MUTATION_TOOLS,
]);

const EXPECTED_UPDATED_AT_TOOLS = new Set([
  "update_page",
  "append_page",
  "move_page",
  "update_template",
  "publish_template",
  "archive_template",
  "delete_template",
]);

const CONFIRMATION_TOOLS = new Set([
  "move_pages",
  "archive_template",
  "delete_template",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasProperty(tool, propertyName) {
  return isObject(tool?.inputSchema?.properties?.[propertyName]);
}

function requiresProperty(tool, propertyName) {
  return (
    Array.isArray(tool?.inputSchema?.required) &&
    tool.inputSchema.required.includes(propertyName)
  );
}

function getObjectProperty(tool, propertyName) {
  const property = tool?.inputSchema?.properties?.[propertyName];
  return isObject(property) ? property : null;
}

function getArrayItemSchema(tool, propertyName) {
  const property = getObjectProperty(tool, propertyName);
  return isObject(property?.items) ? property.items : null;
}

function analyzeToolCatalog(tools) {
  if (!Array.isArray(tools)) {
    return {
      compatible: false,
      coreCompatible: false,
      toolCount: 0,
      missingTools: [...CORE_REQUIRED_TOOLS],
      issues: ["tools/list did not return an array"],
      coreIssues: ["tools/list did not return an array"],
      catalog: {
        supported: false,
        compatible: false,
        missingTools: [...CATALOG_TOOLS],
        issues: ["tools/list did not return an array"],
      },
      catalogV2: {
        supported: false,
        compatible: false,
        missingTools: [...CATALOG_V2_TOOLS],
        issues: ["tools/list did not return an array"],
      },
    };
  }

  const byName = new Map(
    tools
      .filter((tool) => isObject(tool) && typeof tool.name === "string")
      .map((tool) => [tool.name, tool]),
  );
  const missingTools = CORE_REQUIRED_TOOLS.filter((name) => !byName.has(name));
  const coreIssues = [];

  for (const name of CORE_REQUIRED_TOOLS) {
    const tool = byName.get(name);
    if (!tool) continue;
    if (!isObject(tool.inputSchema)) {
      coreIssues.push(`${name} has no inputSchema`);
    }
  }

  for (const name of MUTATION_TOOLS) {
    const tool = byName.get(name);
    if (tool && !requiresProperty(tool, "idempotencyKey")) {
      coreIssues.push(`${name} must require idempotencyKey`);
    }
  }

  for (const name of EXPECTED_UPDATED_AT_TOOLS) {
    const tool = byName.get(name);
    if (tool && !requiresProperty(tool, "expectedUpdatedAt")) {
      coreIssues.push(`${name} must require expectedUpdatedAt`);
    }
  }

  for (const name of CONFIRMATION_TOOLS) {
    const tool = byName.get(name);
    if (tool && !requiresProperty(tool, "confirm")) {
      coreIssues.push(`${name} must require confirm`);
    }
  }

  for (const name of ["search_docs", "semantic_search_docs"]) {
    const tool = byName.get(name);
    if (tool && !hasProperty(tool, "rootPageId")) {
      coreIssues.push(`${name} must support rootPageId`);
    }
  }

  const pageTree = byName.get("get_page_tree");
  if (pageTree && !hasProperty(pageTree, "rootPageId")) {
    coreIssues.push("get_page_tree must support rootPageId");
  }

  const previewMove = byName.get("preview_page_move");
  for (const field of ["pageId", "targetParentPageId", "placement"]) {
    if (previewMove && !requiresProperty(previewMove, field)) {
      coreIssues.push(`preview_page_move must require ${field}`);
    }
  }
  if (previewMove && !hasProperty(previewMove, "referencePageId")) {
    coreIssues.push("preview_page_move must support referencePageId");
  }

  const movePage = byName.get("move_page");
  if (movePage && !requiresProperty(movePage, "movePlanToken")) {
    coreIssues.push("move_page must require movePlanToken");
  }

  const movePages = byName.get("move_pages");
  const moveItem = getArrayItemSchema(movePages, "moves");
  if (movePages && !requiresProperty(movePages, "moves")) {
    coreIssues.push("move_pages must require moves");
  }
  if (movePages && !moveItem) {
    coreIssues.push("move_pages must define a moves item schema");
  } else if (moveItem) {
    for (const field of ["movePlanToken", "expectedUpdatedAt"]) {
      if (!requiresProperty({ inputSchema: moveItem }, field)) {
        coreIssues.push(`move_pages items must require ${field}`);
      }
    }
  }

  const presentCatalogTools = CATALOG_TOOLS.filter((name) => byName.has(name));
  const missingCatalogTools = CATALOG_TOOLS.filter((name) => !byName.has(name));
  const catalogIssues = [];
  for (const name of presentCatalogTools) {
    const tool = byName.get(name);
    if (!isObject(tool?.inputSchema)) {
      catalogIssues.push(`${name} has no inputSchema`);
      continue;
    }
    for (const field of [
      "contract",
      "catalogRootPageId",
      "environment",
      "roots",
      "challenge",
    ]) {
      if (!requiresProperty(tool, field)) {
        catalogIssues.push(`${name} must require ${field}`);
      }
    }
    const contract = getObjectProperty(tool, "contract");
    if (contract?.const !== "qts-fact-catalog.v1") {
      catalogIssues.push(`${name} must require contract qts-fact-catalog.v1`);
    }
    const catalogRootPageId = getObjectProperty(tool, "catalogRootPageId");
    if (catalogRootPageId?.format !== "uuid") {
      catalogIssues.push(`${name} catalogRootPageId must use uuid format`);
    }
    const roots = getObjectProperty(tool, "roots");
    if (
      roots?.type !== "array" ||
      roots.minItems !== 1 ||
      roots.maxItems !== MAX_CATALOG_ROOTS
    ) {
      catalogIssues.push(
        `${name} roots must advertise 1-${MAX_CATALOG_ROOTS} items`,
      );
    }
    const challenge = getObjectProperty(tool, "challenge");
    if (challenge?.minLength !== 16 || challenge?.maxLength !== 128) {
      catalogIssues.push(`${name} challenge must advertise 16-128 bytes`);
    }
  }
  const deltaTool = byName.get("resolve_catalog_delta");
  if (deltaTool && !requiresProperty(deltaTool, "previous")) {
    catalogIssues.push("resolve_catalog_delta must require previous");
  }
  if (deltaTool) {
    const previous = getObjectProperty(deltaTool, "previous");
    const previousRequired = previous?.required;
    const pages = isObject(previous?.properties?.pages)
      ? previous.properties.pages
      : null;
    const pageItem = isObject(pages?.items) ? pages.items : null;
    const pageRequired = pageItem?.required;
    if (
      !Array.isArray(previousRequired) ||
      !previousRequired.includes("bundleFingerprint") ||
      !previousRequired.includes("pages") ||
      pages?.type !== "array" ||
      pages.maxItems !== MAX_CATALOG_PAGES ||
      !Array.isArray(pageRequired) ||
      !["pageId", "updatedAt", "contentSha256"].every((field) =>
        pageRequired.includes(field),
      ) ||
      pageItem?.properties?.pageId?.format !== "uuid" ||
      pageItem?.properties?.updatedAt?.format !== "date-time"
    ) {
      catalogIssues.push(
        "resolve_catalog_delta previous manifest schema is incompatible",
      );
    }
  }
  const catalogSupported = presentCatalogTools.length > 0;
  const catalogCompatible =
    presentCatalogTools.length === CATALOG_TOOLS.length &&
    catalogIssues.length === 0;
  const issues = [...coreIssues];
  if (catalogSupported && missingCatalogTools.length > 0) {
    issues.push(
      `Catalog capability is partial; missing tools: ${missingCatalogTools.join(", ")}`,
    );
  }
  if (catalogSupported) issues.push(...catalogIssues);
  const presentCatalogV2Tools = CATALOG_V2_TOOLS.filter((name) =>
    byName.has(name),
  );
  const missingCatalogV2Tools = CATALOG_V2_TOOLS.filter(
    (name) => !byName.has(name),
  );
  const catalogV2Issues = [];
  for (const name of presentCatalogV2Tools) {
    const tool = byName.get(name);
    if (!isObject(tool?.inputSchema)) {
      catalogV2Issues.push(`${name} has no inputSchema`);
      continue;
    }
    for (const field of [
      "contract",
      "catalogRootPageId",
      "environment",
      "roots",
      "challenge",
    ]) {
      if (!requiresProperty(tool, field)) {
        catalogV2Issues.push(`${name} must require ${field}`);
      }
    }
    if (getObjectProperty(tool, "contract")?.const !== "qts-fact-catalog.v1") {
      catalogV2Issues.push(`${name} must require contract qts-fact-catalog.v1`);
    }
    if (getObjectProperty(tool, "catalogRootPageId")?.format !== "uuid") {
      catalogV2Issues.push(`${name} catalogRootPageId must use uuid format`);
    }
    const roots = getObjectProperty(tool, "roots");
    if (
      roots?.type !== "array" ||
      roots.minItems !== 1 ||
      roots.maxItems !== MAX_CATALOG_ROOTS
    ) {
      catalogV2Issues.push(
        `${name} roots must advertise 1-${MAX_CATALOG_ROOTS} items`,
      );
    }
    const challenge = getObjectProperty(tool, "challenge");
    if (challenge?.minLength !== 16 || challenge?.maxLength !== 128) {
      catalogV2Issues.push(`${name} challenge must advertise 16-128 bytes`);
    }
  }
  const deltaV2Tool = byName.get("resolve_catalog_delta_v2");
  if (deltaV2Tool && !requiresProperty(deltaV2Tool, "previous")) {
    catalogV2Issues.push("resolve_catalog_delta_v2 must require previous");
  }
  if (deltaV2Tool) {
    const previous = getObjectProperty(deltaV2Tool, "previous");
    const previousRequired = previous?.required;
    const pages = isObject(previous?.properties?.pages)
      ? previous.properties.pages
      : null;
    const pageItem = isObject(pages?.items) ? pages.items : null;
    const pageRequired = pageItem?.required;
    if (
      !Array.isArray(previousRequired) ||
      !["bundleFingerprint", "pages", "freshnessProof"].every((field) =>
        previousRequired.includes(field),
      ) ||
      pages?.type !== "array" ||
      pages.maxItems !== MAX_CATALOG_PAGES ||
      !Array.isArray(pageRequired) ||
      !["pageId", "updatedAt", "contentSha256"].every((field) =>
        pageRequired.includes(field),
      ) ||
      pageItem?.properties?.pageId?.format !== "uuid" ||
      pageItem?.properties?.updatedAt?.format !== "date-time" ||
      !isObject(previous?.properties?.freshnessProof)
    ) {
      catalogV2Issues.push(
        "resolve_catalog_delta_v2 previous signed state schema is incompatible",
      );
    }
  }
  const catalogV2Supported = presentCatalogV2Tools.length > 0;
  const catalogV2Compatible =
    presentCatalogV2Tools.length === CATALOG_V2_TOOLS.length &&
    catalogV2Issues.length === 0;
  if (catalogV2Supported && missingCatalogV2Tools.length > 0) {
    issues.push(
      `Catalog v2 capability is partial; missing tools: ${missingCatalogV2Tools.join(", ")}`,
    );
  }
  if (catalogV2Supported) issues.push(...catalogV2Issues);
  const coreCompatible = missingTools.length === 0 && coreIssues.length === 0;

  return {
    compatible:
      coreCompatible &&
      (!catalogSupported || catalogCompatible) &&
      (!catalogV2Supported || catalogV2Compatible),
    coreCompatible,
    toolCount: tools.length,
    missingTools,
    issues,
    coreIssues,
    catalog: {
      supported: catalogSupported,
      compatible: catalogCompatible,
      missingTools: missingCatalogTools,
      issues: catalogIssues,
    },
    catalogV2: {
      supported: catalogV2Supported,
      compatible: catalogV2Compatible,
      missingTools: missingCatalogV2Tools,
      issues: catalogV2Issues,
    },
  };
}

function formatContractReport(report) {
  const details = [];
  if (report.missingTools.length > 0) {
    details.push(`missing tools: ${report.missingTools.join(", ")}`);
  }
  details.push(...report.issues);
  return details.join("; ");
}

function isRetrySafe(method, params) {
  if (method === "tools/list") return true;
  if (method !== "tools/call") return false;
  const toolName = params?.name;
  return (
    typeof toolName === "string" &&
    (CORE_REQUIRED_TOOLS.includes(toolName) ||
      CATALOG_TOOLS.includes(toolName)) &&
    !MUTATION_TOOLS.has(toolName)
  );
}

module.exports = {
  CONFIRMATION_TOOLS,
  CORE_REQUIRED_TOOLS,
  CATALOG_TOOLS,
  CATALOG_V2_TOOLS,
  EXPECTED_UPDATED_AT_TOOLS,
  MUTATION_TOOLS,
  REQUIRED_TOOLS,
  TEMPLATE_MUTATION_TOOLS,
  TEMPLATE_READ_TOOLS,
  analyzeToolCatalog,
  formatContractReport,
  isRetrySafe,
};
