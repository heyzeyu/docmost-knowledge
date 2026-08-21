"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CATALOG_BUNDLE_SCHEMA_VERSION,
  CATALOG_DELTA_SCHEMA_VERSION,
  CATALOG_FRESHNESS_SCHEMA_VERSION,
  QTS_FACT_CATALOG_CONTRACT,
  computeBundleFingerprint,
  pageManifest,
  sha256,
  validateCatalogToolInput,
  validateCatalogToolResult,
} = require("../scripts/catalog-bundle-contract.cjs");

const rootPageId = "11111111-1111-4111-8111-111111111111";
const spaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const updatedAt = "2026-08-20T00:00:00.000Z";

function bundleInput(overrides = {}) {
  return {
    contract: QTS_FACT_CATALOG_CONTRACT,
    catalogRootPageId: rootPageId,
    environment: "prod",
    roots: [{ pageId: rootPageId }],
    challenge: "diagnosis-unique-0001",
    ...overrides,
  };
}

function catalogPage(
  markdown = "---\ndocument_type: service_profile\nschema_version: service-profile.v2\nentity_id: service/example\n---\n# Example",
) {
  return {
    page_id: rootPageId,
    title: "Example",
    parent_page_id: null,
    space_id: spaceId,
    updated_at: updatedAt,
    content_sha256: sha256(markdown),
    front_matter: {
      document_type: "service_profile",
      schema_version: "service-profile.v2",
      entity_id: "service/example",
    },
    markdown,
  };
}

function bundlePayload(
  input = bundleInput(),
  pageValue = catalogPage(),
  edges = [],
) {
  const roots = [
    {
      selector: { page_id: rootPageId },
      status: "resolved",
      page_id: rootPageId,
      document_type: "service_profile",
      entity_id: "service/example",
    },
  ];
  const pages = Array.isArray(pageValue) ? pageValue : [pageValue];
  const manifest = pageManifest(pages);
  const fingerprint = computeBundleFingerprint({
    catalogRootPageId: rootPageId,
    environment: input.environment,
    roots,
    pages: manifest,
    edges,
    unresolvedReferences: [],
  });
  return {
    content: [{ type: "text", text: `Catalog bundle ${fingerprint}` }],
    structuredContent: {
      schema_version: CATALOG_BUNDLE_SCHEMA_VERSION,
      contract: QTS_FACT_CATALOG_CONTRACT,
      catalog_root: {
        page_id: rootPageId,
        title: "Catalog",
        space_id: spaceId,
        updated_at: updatedAt,
      },
      environment: input.environment,
      roots,
      pages,
      edges,
      unresolved_references: [],
      closure_complete: true,
      bundle_fingerprint: fingerprint,
      freshness_proof: {
        schema_version: CATALOG_FRESHNESS_SCHEMA_VERSION,
        challenge: input.challenge,
        verified_at: "2026-08-20T00:00:01.000Z",
        isolation: "repeatable_read",
        read_only: true,
        page_manifest: manifest,
        bundle_fingerprint: fingerprint,
      },
    },
  };
}

function deltaPayload(input, currentPage) {
  const bundleResult = bundlePayload(input, currentPage).structuredContent;
  const previous = {
    page_id: input.previous.pages[0].pageId,
    updated_at: input.previous.pages[0].updatedAt,
    content_sha256: input.previous.pages[0].contentSha256,
  };
  return {
    content: [{ type: "text", text: "Catalog delta" }],
    structuredContent: {
      schema_version: CATALOG_DELTA_SCHEMA_VERSION,
      contract: QTS_FACT_CATALOG_CONTRACT,
      previous_bundle_fingerprint: input.previous.bundleFingerprint,
      bundle_fingerprint: bundleResult.bundle_fingerprint,
      changed: true,
      catalog_root: bundleResult.catalog_root,
      environment: bundleResult.environment,
      roots: bundleResult.roots,
      current_page_manifest: bundleResult.freshness_proof.page_manifest,
      edges: [],
      unresolved_references: [],
      closure_complete: true,
      changes: {
        added: [],
        updated: [{ previous, current: currentPage }],
        removed: [],
        unchanged: [],
      },
      freshness_proof: bundleResult.freshness_proof,
    },
  };
}

function refreshBundleFingerprint(result) {
  const bundle = result.structuredContent;
  const fingerprint = computeBundleFingerprint({
    catalogRootPageId: bundle.catalog_root.page_id,
    environment: bundle.environment,
    roots: bundle.roots,
    pages: pageManifest(bundle.pages),
    edges: bundle.edges,
    unresolvedReferences: bundle.unresolved_references,
  });
  bundle.bundle_fingerprint = fingerprint;
  bundle.freshness_proof.bundle_fingerprint = fingerprint;
}

test("validates a complete Catalog bundle and freshness proof", () => {
  const input = bundleInput();
  const result = bundlePayload(input);

  assert.equal(
    validateCatalogToolResult("resolve_catalog_bundle", input, result),
    result,
  );
});

test("accepts multi-page bundles ordered by page_id instead of content hash", () => {
  const input = bundleInput();
  const firstPage = catalogPage();
  let secondPage;
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = catalogPage(
      `---\ndocument_type: fact_source_profile\nschema_version: fact-source-profile.v2\nentity_id: fact-source/example\n---\n# Candidate ${index}`,
    );
    candidate.page_id = "22222222-2222-4222-8222-222222222222";
    candidate.front_matter = {
      document_type: "fact_source_profile",
      schema_version: "fact-source-profile.v2",
      entity_id: "fact-source/example",
    };
    if (candidate.content_sha256 < firstPage.content_sha256) {
      secondPage = candidate;
      break;
    }
  }
  assert.ok(secondPage, "expected a reverse hash ordering fixture");
  const result = bundlePayload(
    input,
    [firstPage, secondPage],
    [
      {
        from_page_id: firstPage.page_id,
        to_page_id: secondPage.page_id,
        relation: "fact_sources",
        target: {
          document_type: "fact_source_profile",
          entity_id: "fact-source/example",
        },
      },
    ],
  );

  assert.equal(
    validateCatalogToolResult("resolve_catalog_bundle", input, result),
    result,
  );
});

test("rejects roots and edges whose identities disagree with target pages", () => {
  const input = bundleInput();
  const rootMismatch = bundlePayload(input);
  rootMismatch.structuredContent.roots[0].document_type =
    "infrastructure_profile";
  refreshBundleFingerprint(rootMismatch);
  assert.throws(
    () =>
      validateCatalogToolResult(
        "resolve_catalog_bundle",
        input,
        rootMismatch,
      ),
    /page identity/,
  );

  const sourcePage = catalogPage(
    "---\ndocument_type: fact_source_profile\nschema_version: fact-source-profile.v2\nentity_id: fact-source/example\n---\n# Source",
  );
  sourcePage.page_id = "22222222-2222-4222-8222-222222222222";
  sourcePage.front_matter = {
    document_type: "fact_source_profile",
    schema_version: "fact-source-profile.v2",
    entity_id: "fact-source/example",
  };
  const edgeMismatch = bundlePayload(
    input,
    [catalogPage(), sourcePage],
    [
      {
        from_page_id: rootPageId,
        to_page_id: sourcePage.page_id,
        relation: "fact_sources",
        target: {
          document_type: "fact_source_profile",
          entity_id: "fact-source/other",
        },
      },
    ],
  );
  refreshBundleFingerprint(edgeMismatch);
  assert.throws(
    () =>
      validateCatalogToolResult(
        "resolve_catalog_bundle",
        input,
        edgeMismatch,
      ),
    /target entity/,
  );
});

test("rejects tampered Markdown, fingerprint, and challenge", () => {
  const input = bundleInput();
  const tamperedMarkdown = structuredClone(bundlePayload(input));
  tamperedMarkdown.structuredContent.pages[0].markdown += "\ntampered";
  assert.throws(
    () =>
      validateCatalogToolResult(
        "resolve_catalog_bundle",
        input,
        tamperedMarkdown,
      ),
    /content hash/,
  );

  const tamperedFingerprint = structuredClone(bundlePayload(input));
  tamperedFingerprint.structuredContent.bundle_fingerprint = "0".repeat(64);
  assert.throws(
    () =>
      validateCatalogToolResult(
        "resolve_catalog_bundle",
        input,
        tamperedFingerprint,
      ),
    /fingerprint/,
  );

  const tamperedChallenge = structuredClone(bundlePayload(input));
  tamperedChallenge.structuredContent.freshness_proof.challenge =
    "different-challenge";
  assert.throws(
    () =>
      validateCatalogToolResult(
        "resolve_catalog_bundle",
        input,
        tamperedChallenge,
      ),
    /challenge/,
  );
});

test("validates a fully partitioned same-timestamp Catalog delta", () => {
  const previousPage = catalogPage();
  const previousBundle = bundlePayload(
    bundleInput(),
    previousPage,
  ).structuredContent;
  const currentPage = catalogPage(`${previousPage.markdown}\nchanged`);
  const input = bundleInput({
    challenge: "diagnosis-unique-0002",
    previous: {
      bundleFingerprint: previousBundle.bundle_fingerprint,
      pages: [
        {
          pageId: previousPage.page_id,
          updatedAt: previousPage.updated_at,
          contentSha256: previousPage.content_sha256,
        },
      ],
    },
  });
  const result = deltaPayload(input, currentPage);

  assert.equal(
    validateCatalogToolResult("resolve_catalog_delta", input, result),
    result,
  );
});

test("rejects duplicate previous manifests and incomplete delta partitions", () => {
  const previousPage = catalogPage();
  const previousBundle = bundlePayload().structuredContent;
  const previousItem = {
    pageId: previousPage.page_id,
    updatedAt: previousPage.updated_at,
    contentSha256: previousPage.content_sha256,
  };
  assert.throws(
    () =>
      validateCatalogToolInput("resolve_catalog_delta", {
        ...bundleInput(),
        previous: {
          bundleFingerprint: previousBundle.bundle_fingerprint,
          pages: [previousItem, previousItem],
        },
      }),
    /duplicates/,
  );

  const currentPage = catalogPage(`${previousPage.markdown}\nchanged`);
  const input = bundleInput({
    previous: {
      bundleFingerprint: previousBundle.bundle_fingerprint,
      pages: [previousItem],
    },
  });
  const result = deltaPayload(input, currentPage);
  result.structuredContent.changes.updated = [];
  assert.throws(
    () => validateCatalogToolResult("resolve_catalog_delta", input, result),
    /complete page partition/,
  );
});
