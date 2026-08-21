"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CATALOG_TOOLS,
  CATALOG_V2_TOOLS,
  CATALOG_V3_TOOLS,
  CONFIRMATION_TOOLS,
  EXPECTED_UPDATED_AT_TOOLS,
  MUTATION_TOOLS,
  REQUIRED_TOOLS,
  TEMPLATE_MUTATION_TOOLS,
  TEMPLATE_READ_TOOLS,
  analyzeToolCatalog,
  formatContractReport,
  isRetrySafe,
} = require("../scripts/tool-contract.cjs");

function addCatalogCapabilities(catalog, names = CATALOG_TOOLS) {
  for (const name of names) {
    const required = [
      "contract",
      "catalogRootPageId",
      "environment",
      "roots",
      "challenge",
    ];
    const properties = {
      contract: { type: "string", const: "qts-fact-catalog.v1" },
      catalogRootPageId: { type: "string", format: "uuid" },
      environment: { type: "string" },
      roots: { type: "array", minItems: 1, maxItems: 32 },
      challenge: { type: "string", minLength: 16, maxLength: 128 },
    };
    if (name === "resolve_catalog_delta") {
      required.push("previous");
      properties.previous = {
        type: "object",
        properties: {
          bundleFingerprint: { type: "string" },
          pages: {
            type: "array",
            maxItems: 512,
            items: {
              type: "object",
              properties: {
                pageId: { type: "string", format: "uuid" },
                updatedAt: { type: "string", format: "date-time" },
                contentSha256: { type: "string" },
              },
              required: ["pageId", "updatedAt", "contentSha256"],
            },
          },
        },
        required: ["bundleFingerprint", "pages"],
      };
    }
    catalog.push({
      name,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
  }
  return catalog;
}

function addCatalogV2Capabilities(catalog, names = CATALOG_V2_TOOLS) {
  for (const name of names) {
    const required = [
      "contract",
      "catalogRootPageId",
      "environment",
      "roots",
      "challenge",
    ];
    const properties = {
      contract: { type: "string", const: "qts-fact-catalog.v1" },
      catalogRootPageId: { type: "string", format: "uuid" },
      environment: { type: "string" },
      roots: { type: "array", minItems: 1, maxItems: 32 },
      challenge: { type: "string", minLength: 16, maxLength: 128 },
    };
    if (name === "resolve_catalog_delta_v2") {
      required.push("previous");
      properties.previous = {
        type: "object",
        properties: {
          bundleFingerprint: { type: "string" },
          pages: {
            type: "array",
            maxItems: 512,
            items: {
              type: "object",
              properties: {
                pageId: { type: "string", format: "uuid" },
                updatedAt: { type: "string", format: "date-time" },
                contentSha256: { type: "string" },
              },
              required: ["pageId", "updatedAt", "contentSha256"],
            },
          },
          freshnessProof: { type: "object" },
        },
        required: ["bundleFingerprint", "pages", "freshnessProof"],
      };
    }
    catalog.push({
      name,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
  }
  return catalog;
}

function addCatalogV3Capabilities(catalog, names = CATALOG_V3_TOOLS) {
  const ticketProperties = Object.fromEntries(
    [
      "schema_version",
      "signature_algorithm",
      "public_key_format",
      "public_key",
      "key_id",
      "ticket_id",
      "issued_at",
      "expires_at",
      "challenge",
      "catalog_root_page_id",
      "environment",
      "authorization_context_sha256",
      "signature",
    ].map((field) => [field, { type: "string" }]),
  );
  const ticket = {
    type: "object",
    properties: ticketProperties,
    required: Object.keys(ticketProperties),
    additionalProperties: false,
  };
  for (const name of names) {
    const isBegin = name === "begin_catalog_resolution";
    const required = isBegin
      ? ["contract", "catalogRootPageId", "environment", "challenge"]
      : ["contract", "catalogRootPageId", "environment", "roots", "ticket"];
    const properties = {
      contract: { type: "string", const: "qts-fact-catalog.v1" },
      catalogRootPageId: { type: "string", format: "uuid" },
      environment: { type: "string" },
      ...(isBegin
        ? { challenge: { type: "string", minLength: 16, maxLength: 128 } }
        : {
            roots: { type: "array", minItems: 1, maxItems: 32 },
            ticket,
          }),
    };
    if (name === "resolve_catalog_delta_v3") {
      required.push("previous");
      properties.previous = {
        type: "object",
        properties: {
          bundleFingerprint: { type: "string" },
          pages: {
            type: "array",
            maxItems: 512,
            items: {
              type: "object",
              properties: {
                pageId: { type: "string", format: "uuid" },
                updatedAt: { type: "string", format: "date-time" },
                contentSha256: { type: "string" },
                frontMatterSha256: { type: "string" },
              },
              required: [
                "pageId",
                "updatedAt",
                "contentSha256",
                "frontMatterSha256",
              ],
            },
          },
          freshnessProof: { type: "object" },
        },
        required: ["bundleFingerprint", "pages", "freshnessProof"],
      };
    }
    catalog.push({
      name,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
  }
  return catalog;
}

function createCompatibleCatalog() {
  return REQUIRED_TOOLS.map((name) => {
    const properties = {};
    const required = [];
    if (MUTATION_TOOLS.has(name)) {
      properties.idempotencyKey = { type: "string" };
      required.push("idempotencyKey");
    }
    if (EXPECTED_UPDATED_AT_TOOLS.has(name)) {
      properties.expectedUpdatedAt = {
        type: "string",
        format: "date-time",
      };
      required.push("expectedUpdatedAt");
    }
    if (CONFIRMATION_TOOLS.has(name)) {
      properties.confirm = { type: "boolean" };
      required.push("confirm");
    }
    if (name === "search_docs" || name === "semantic_search_docs") {
      properties.rootPageId = { type: "string", format: "uuid" };
    }
    if (name === "get_page_tree") {
      properties.rootPageId = { type: "string", format: "uuid" };
    }
    if (name === "preview_page_move") {
      properties.pageId = { type: "string", format: "uuid" };
      properties.targetParentPageId = { type: ["string", "null"] };
      properties.placement = {
        type: "string",
        enum: ["first", "last", "before", "after"],
      };
      properties.referencePageId = { type: "string", format: "uuid" };
      required.push("pageId", "targetParentPageId", "placement");
    }
    if (name === "move_page") {
      properties.movePlanToken = { type: "string" };
      required.push("movePlanToken");
    }
    if (name === "move_pages") {
      properties.moves = {
        type: "array",
        items: {
          type: "object",
          properties: {
            movePlanToken: { type: "string" },
            expectedUpdatedAt: { type: "string", format: "date-time" },
          },
          required: ["movePlanToken", "expectedUpdatedAt"],
          additionalProperties: false,
        },
      };
      required.push("moves");
    }
    return {
      name,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    };
  });
}

test("analyzeToolCatalog keeps the v0.4 core contract compatible", () => {
  const report = analyzeToolCatalog(createCompatibleCatalog());

  assert.equal(report.compatible, true);
  assert.equal(report.coreCompatible, true);
  assert.equal(report.toolCount, REQUIRED_TOOLS.length);
  assert.deepEqual(report.missingTools, []);
  assert.deepEqual(report.issues, []);
  assert.equal(report.catalog.supported, false);
  assert.equal(report.catalog.compatible, false);
  assert.deepEqual(report.catalog.missingTools, CATALOG_TOOLS);
  assert.equal(report.catalogV2.supported, false);
  assert.equal(report.catalogV2.compatible, false);
  assert.deepEqual(report.catalogV2.missingTools, CATALOG_V2_TOOLS);
  assert.equal(report.catalogV3.supported, false);
  assert.equal(report.catalogV3.compatible, false);
  assert.deepEqual(report.catalogV3.missingTools, CATALOG_V3_TOOLS);
});

test("analyzeToolCatalog accepts the complete signed Catalog v2 capability", () => {
  const catalog = addCatalogV2Capabilities(createCompatibleCatalog());
  const report = analyzeToolCatalog(catalog);

  assert.equal(report.compatible, true);
  assert.equal(report.catalogV2.supported, true);
  assert.equal(report.catalogV2.compatible, true);
  assert.deepEqual(report.catalogV2.missingTools, []);
  assert.deepEqual(report.catalogV2.issues, []);
});

test("analyzeToolCatalog rejects partial or unsigned Catalog v2 schemas", () => {
  const partial = analyzeToolCatalog(
    addCatalogV2Capabilities(createCompatibleCatalog(), [
      "resolve_catalog_bundle_v2",
    ]),
  );
  assert.equal(partial.compatible, false);
  assert.deepEqual(partial.catalogV2.missingTools, [
    "resolve_catalog_delta_v2",
  ]);
  assert.match(
    formatContractReport(partial),
    /Catalog v2 capability is partial/,
  );

  const catalog = addCatalogV2Capabilities(createCompatibleCatalog());
  const delta = catalog.find(
    (tool) => tool.name === "resolve_catalog_delta_v2",
  );
  delta.inputSchema.properties.previous.required = [
    "bundleFingerprint",
    "pages",
  ];
  const unsigned = analyzeToolCatalog(catalog);
  assert.equal(unsigned.catalogV2.compatible, false);
  assert.match(
    formatContractReport(unsigned),
    /previous signed state schema is incompatible/,
  );
});

test("analyzeToolCatalog accepts the complete ticketed Catalog v3 capability", () => {
  const report = analyzeToolCatalog(
    addCatalogV3Capabilities(createCompatibleCatalog()),
  );
  assert.equal(report.compatible, true);
  assert.equal(report.catalogV3.supported, true);
  assert.equal(report.catalogV3.compatible, true);
  assert.deepEqual(report.catalogV3.missingTools, []);
  assert.deepEqual(report.catalogV3.issues, []);
});

test("analyzeToolCatalog rejects partial or non-ticketed Catalog v3 schemas", () => {
  const partial = analyzeToolCatalog(
    addCatalogV3Capabilities(createCompatibleCatalog(), [
      "begin_catalog_resolution",
      "resolve_catalog_bundle_v3",
    ]),
  );
  assert.equal(partial.compatible, false);
  assert.deepEqual(partial.catalogV3.missingTools, [
    "resolve_catalog_delta_v3",
  ]);

  const catalog = addCatalogV3Capabilities(createCompatibleCatalog());
  const bundle = catalog.find(
    (tool) => tool.name === "resolve_catalog_bundle_v3",
  );
  bundle.inputSchema.required = bundle.inputSchema.required.filter(
    (field) => field !== "ticket",
  );
  const invalid = analyzeToolCatalog(catalog);
  assert.equal(invalid.catalogV3.compatible, false);
  assert.match(formatContractReport(invalid), /must require ticket/);
});

test("analyzeToolCatalog accepts the complete optional Catalog capability", () => {
  const catalog = addCatalogCapabilities(createCompatibleCatalog());
  const report = analyzeToolCatalog(catalog);

  assert.equal(report.compatible, true);
  assert.equal(report.catalog.supported, true);
  assert.equal(report.catalog.compatible, true);
  assert.deepEqual(report.catalog.missingTools, []);
  assert.deepEqual(report.catalog.issues, []);
});

test("analyzeToolCatalog rejects a partial Catalog capability", () => {
  const catalog = addCatalogCapabilities(createCompatibleCatalog(), [
    "resolve_catalog_bundle",
  ]);
  const report = analyzeToolCatalog(catalog);

  assert.equal(report.compatible, false);
  assert.equal(report.coreCompatible, true);
  assert.equal(report.catalog.supported, true);
  assert.equal(report.catalog.compatible, false);
  assert.deepEqual(report.catalog.missingTools, ["resolve_catalog_delta"]);
  assert.match(formatContractReport(report), /Catalog capability is partial/);
});

test("analyzeToolCatalog rejects incompatible Catalog schemas only", () => {
  const catalog = addCatalogCapabilities(createCompatibleCatalog());
  const bundle = catalog.find((tool) => tool.name === "resolve_catalog_bundle");
  delete bundle.inputSchema.properties.challenge.maxLength;
  const report = analyzeToolCatalog(catalog);

  assert.equal(report.compatible, false);
  assert.equal(report.coreCompatible, true);
  assert.equal(report.catalog.supported, true);
  assert.equal(report.catalog.compatible, false);
  assert.match(formatContractReport(report), /challenge/);
});

test("analyzeToolCatalog identifies missing tools and hardened fields", () => {
  const catalog = createCompatibleCatalog().filter(
    (tool) => tool.name !== "delete_template",
  );
  const updatePage = catalog.find((tool) => tool.name === "update_page");
  updatePage.inputSchema.required = [];
  const searchDocs = catalog.find((tool) => tool.name === "search_docs");
  delete searchDocs.inputSchema.properties.rootPageId;
  const createTemplate = catalog.find(
    (tool) => tool.name === "create_template",
  );
  createTemplate.inputSchema.required =
    createTemplate.inputSchema.required.filter(
      (field) => field !== "idempotencyKey",
    );
  const updateTemplate = catalog.find(
    (tool) => tool.name === "update_template",
  );
  updateTemplate.inputSchema.required =
    updateTemplate.inputSchema.required.filter(
      (field) => field !== "expectedUpdatedAt",
    );
  const archiveTemplate = catalog.find(
    (tool) => tool.name === "archive_template",
  );
  archiveTemplate.inputSchema.required =
    archiveTemplate.inputSchema.required.filter((field) => field !== "confirm");
  const previewMove = catalog.find((tool) => tool.name === "preview_page_move");
  previewMove.inputSchema.required = previewMove.inputSchema.required.filter(
    (field) => field !== "placement",
  );
  const movePages = catalog.find((tool) => tool.name === "move_pages");
  movePages.inputSchema.properties.moves.items.required = ["movePlanToken"];

  const report = analyzeToolCatalog(catalog);
  const summary = formatContractReport(report);

  assert.equal(report.compatible, false);
  assert.equal(report.coreCompatible, false);
  assert.deepEqual(report.missingTools, ["delete_template"]);
  assert.match(summary, /update_page must require idempotencyKey/);
  assert.match(summary, /update_page must require expectedUpdatedAt/);
  assert.match(summary, /search_docs must support rootPageId/);
  assert.match(summary, /create_template must require idempotencyKey/);
  assert.match(summary, /update_template must require expectedUpdatedAt/);
  assert.match(summary, /archive_template must require confirm/);
  assert.match(summary, /preview_page_move must require placement/);
  assert.match(summary, /move_pages items must require expectedUpdatedAt/);
});

test("isRetrySafe retries only known read operations", () => {
  assert.equal(isRetrySafe("tools/list"), true);
  assert.equal(
    isRetrySafe("tools/call", { name: "search_docs", arguments: {} }),
    true,
  );
  assert.equal(
    isRetrySafe("tools/call", { name: "render_template", arguments: {} }),
    true,
  );
  assert.equal(
    isRetrySafe("tools/call", { name: "get_page_tree", arguments: {} }),
    true,
  );
  assert.equal(
    isRetrySafe("tools/call", {
      name: "preview_page_move",
      arguments: {},
    }),
    true,
  );
  for (const name of CATALOG_TOOLS) {
    assert.equal(isRetrySafe("tools/call", { name, arguments: {} }), true);
  }
  for (const name of CATALOG_V2_TOOLS) {
    assert.equal(isRetrySafe("tools/call", { name, arguments: {} }), false);
  }
  for (const name of CATALOG_V3_TOOLS) {
    assert.equal(isRetrySafe("tools/call", { name, arguments: {} }), false);
  }
  for (const name of TEMPLATE_READ_TOOLS) {
    assert.equal(isRetrySafe("tools/call", { name, arguments: {} }), true);
  }
  assert.equal(
    isRetrySafe("tools/call", { name: "update_page", arguments: {} }),
    false,
  );
  assert.equal(
    isRetrySafe("tools/call", { name: "move_pages", arguments: {} }),
    false,
  );
  assert.equal(
    isRetrySafe("tools/call", {
      name: "instantiate_template",
      arguments: {},
    }),
    false,
  );
  for (const name of TEMPLATE_MUTATION_TOOLS) {
    assert.equal(isRetrySafe("tools/call", { name, arguments: {} }), false);
  }
  assert.equal(
    isRetrySafe("tools/call", { name: "future_unknown_tool", arguments: {} }),
    false,
  );
});
