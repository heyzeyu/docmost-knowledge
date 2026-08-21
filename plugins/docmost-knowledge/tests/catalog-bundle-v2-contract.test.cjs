"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync, sign: signBytes } = require("node:crypto");
const test = require("node:test");

const {
  computeBundleV2Fingerprint,
  pageManifest,
  sha256,
  stableStringify,
  validateCatalogV2ToolInput,
  validateCatalogV2ToolResult,
} = require("../scripts/catalog-bundle-v2-contract.cjs");

const CATALOG_ROOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const KRC_ID = "33333333-3333-4333-8333-333333333333";
const REMOVED_ID = "44444444-4444-4444-8444-444444444444";
const ADDED_ID = "55555555-5555-4555-8555-555555555555";
const UPDATED_AT = "2026-08-21T00:00:00.000Z";
const FETCHED_AT = "2026-08-21T00:00:01.000Z";
const RESOLUTION_STARTED_AT = "2026-08-21T00:00:00.500Z";
const VERIFIED_AT = "2026-08-21T00:00:02.000Z";
const EXTRACTOR_VERSION = "qts-fact-catalog-extractor.v2.0.0";

function canonicalSort(values) {
  return [...values].sort((left, right) => {
    const a = stableStringify(left);
    const b = stableStringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function markdown(frontMatter, body) {
  return [
    "# Catalog document",
    "",
    "```yaml",
    frontMatter.trim(),
    "```",
    "",
    body,
  ].join("\n");
}

function catalogPage(pageId, frontMatter, frontMatterYaml, body = "Body") {
  const source = markdown(frontMatterYaml, body);
  return {
    page_id: pageId,
    title: pageId,
    parent_page_id: CATALOG_ROOT_ID,
    space_id: SPACE_ID,
    updated_at: UPDATED_AT,
    content_sha256: sha256(source),
    fetched_at: FETCHED_AT,
    front_matter: frontMatter,
    markdown: source,
  };
}

function createSigner(keyId = "catalog-ed25519-current") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
  };
}

function signProof({
  signer,
  challenge,
  pages,
  fingerprint,
  roots = [{ page_id: SERVICE_ID }],
  resolutionElapsedMs = 1500,
}) {
  const unsigned = {
    schema_version: "catalog-freshness-proof.v2",
    signature_algorithm: "ed25519",
    public_key_format: "spki-der-base64url",
    public_key: signer.publicKey,
    key_id: signer.keyId,
    challenge,
    resolution_started_at: RESOLUTION_STARTED_AT,
    verified_at: VERIFIED_AT,
    resolution_elapsed_ms: resolutionElapsedMs,
    catalog_root_page_id: CATALOG_ROOT_ID,
    environment: "prod",
    authorization_context_sha256: "a".repeat(64),
    requested_roots: roots,
    isolation: "repeatable_read",
    read_only: true,
    page_manifest: pageManifest(pages),
    reference_extractor_version: EXTRACTOR_VERSION,
    bundle_fingerprint: fingerprint,
  };
  return {
    ...unsigned,
    signature: signBytes(
      null,
      Buffer.from(stableStringify(unsigned), "utf8"),
      signer.privateKey,
    ).toString("base64url"),
  };
}

function createBasePages() {
  return [
    catalogPage(
      SERVICE_ID,
      {
        document_type: "service_profile",
        schema_version: "service-profile.v2",
        entity_id: "service/neptune",
        fact_sources: ["fact-source/tencent-tke"],
      },
      `
document_type: service_profile
schema_version: service-profile.v2
entity_id: service/neptune
fact_sources:
  - fact-source/tencent-tke
`,
      "Service body",
    ),
    catalogPage(
      SOURCE_ID,
      {
        document_type: "fact_source_profile",
        schema_version: "fact-source-profile.v2",
        entity_id: "fact-source/tencent-tke",
        fact_sources: ["fact-source/legacy"],
      },
      `
document_type: fact_source_profile
schema_version: fact-source-profile.v2
entity_id: fact-source/tencent-tke
fact_sources:
  - fact-source/legacy
`,
      "Source body",
    ),
    catalogPage(
      KRC_ID,
      {
        document_type: "known_root_cause",
        schema_version: "known-root-cause.v1",
        entity_id: "known-root-cause/neptune-timeout",
        status: "active",
        affected_entities: ["service/neptune"],
        environment_scope: ["prod"],
        verification: { status: "confirmed" },
      },
      `
document_type: known_root_cause
schema_version: known-root-cause.v1
entity_id: known-root-cause/neptune-timeout
status: active
affected_entities:
  - service/neptune
environment_scope:
  - prod
verification:
  status: confirmed
`,
      "Known root cause body",
    ),
    catalogPage(
      REMOVED_ID,
      {
        document_type: "fact_source_profile",
        schema_version: "fact-source-profile.v2",
        entity_id: "fact-source/legacy",
      },
      `
document_type: fact_source_profile
schema_version: fact-source-profile.v2
entity_id: fact-source/legacy
`,
      "Legacy source",
    ),
  ];
}

function createCurrentPages() {
  const base = createBasePages();
  return [
    base[0],
    catalogPage(
      SOURCE_ID,
      {
        document_type: "fact_source_profile",
        schema_version: "fact-source-profile.v2",
        entity_id: "fact-source/tencent-tke",
        fact_sources: ["fact-source/current"],
      },
      `
document_type: fact_source_profile
schema_version: fact-source-profile.v2
entity_id: fact-source/tencent-tke
fact_sources:
  - fact-source/current
`,
      "Source body changed without an updated_at change",
    ),
    base[2],
    catalogPage(
      ADDED_ID,
      {
        document_type: "fact_source_profile",
        schema_version: "fact-source-profile.v2",
        entity_id: "fact-source/current",
      },
      `
document_type: fact_source_profile
schema_version: fact-source-profile.v2
entity_id: fact-source/current
`,
      "Current source",
    ),
  ];
}

function roots() {
  return [
    {
      selector: { page_id: SERVICE_ID },
      status: "resolved",
      page_id: SERVICE_ID,
      document_type: "service_profile",
      entity_id: "service/neptune",
    },
  ];
}

function candidates() {
  return [
    {
      page_id: KRC_ID,
      document_type: "known_root_cause",
      entity_id: "known-root-cause/neptune-timeout",
      affected_entities: ["service/neptune"],
      environment_scope: ["prod"],
      selection_reason:
        "active confirmed candidate for service/neptune in prod",
    },
  ];
}

function closureStatus() {
  return {
    roots_resolved: true,
    reference_fields_scanned: true,
    required_targets_resolved: true,
    unresolved_references_empty: true,
    known_root_cause_discovery_complete: true,
  };
}

function baseEdges() {
  return canonicalSort([
    {
      from_page_id: SERVICE_ID,
      to_page_id: SOURCE_ID,
      relation: "fact_sources",
      target: {
        document_type: "fact_source_profile",
        entity_id: "fact-source/tencent-tke",
      },
    },
    {
      from_page_id: SOURCE_ID,
      to_page_id: REMOVED_ID,
      relation: "fact_sources",
      target: {
        document_type: "fact_source_profile",
        entity_id: "fact-source/legacy",
      },
    },
    {
      from_page_id: KRC_ID,
      to_page_id: SERVICE_ID,
      relation: "known_root_cause.affected_entities",
      target: {
        document_type: "service_profile",
        entity_id: "service/neptune",
      },
    },
  ]);
}

function currentEdges() {
  return canonicalSort(
    baseEdges().map((edge) =>
      edge.from_page_id === SOURCE_ID
        ? {
            ...edge,
            to_page_id: ADDED_ID,
            target: {
              document_type: "fact_source_profile",
              entity_id: "fact-source/current",
            },
          }
        : edge,
    ),
  );
}

function createBundle(signer = createSigner()) {
  const pages = createBasePages().sort((a, b) =>
    a.page_id.localeCompare(b.page_id),
  );
  const input = {
    contract: "qts-fact-catalog.v1",
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: "prod",
    roots: [{ pageId: SERVICE_ID }],
    challenge: "diagnosis-unique-0001",
  };
  const graph = {
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: "prod",
    roots: roots(),
    knownRootCauseCandidates: candidates(),
    pages: pageManifest(pages),
    edges: baseEdges(),
    unresolvedReferences: [],
    closureStatus: closureStatus(),
  };
  const fingerprint = computeBundleV2Fingerprint(graph);
  const bundle = {
    schema_version: "catalog-bundle.v2",
    contract: "qts-fact-catalog.v1",
    catalog_root: {
      page_id: CATALOG_ROOT_ID,
      title: "Fact Catalog",
      space_id: SPACE_ID,
      updated_at: UPDATED_AT,
    },
    environment: "prod",
    roots: graph.roots,
    known_root_cause_candidates: graph.knownRootCauseCandidates,
    pages,
    edges: graph.edges,
    unresolved_references: [],
    closure_status: graph.closureStatus,
    closure_complete: true,
    reference_extractor_version: EXTRACTOR_VERSION,
    bundle_fingerprint: fingerprint,
    freshness_proof: signProof({
      signer,
      challenge: input.challenge,
      pages,
      fingerprint,
    }),
  };
  return { input, bundle, signer };
}

function createDelta(bundleFixture, signer = bundleFixture.signer) {
  const pages = createCurrentPages().sort((a, b) =>
    a.page_id.localeCompare(b.page_id),
  );
  const input = {
    ...bundleFixture.input,
    challenge: "diagnosis-unique-0002",
    previous: {
      bundleFingerprint: bundleFixture.bundle.bundle_fingerprint,
      pages: bundleFixture.bundle.pages.map((page) => ({
        pageId: page.page_id,
        updatedAt: page.updated_at,
        contentSha256: page.content_sha256,
      })),
      freshnessProof: bundleFixture.bundle.freshness_proof,
    },
  };
  const graph = {
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: "prod",
    roots: roots(),
    knownRootCauseCandidates: candidates(),
    pages: pageManifest(pages),
    edges: currentEdges(),
    unresolvedReferences: [],
    closureStatus: closureStatus(),
  };
  const fingerprint = computeBundleV2Fingerprint(graph);
  const previousById = new Map(
    bundleFixture.bundle.pages.map((page) => [
      page.page_id,
      {
        page_id: page.page_id,
        updated_at: page.updated_at,
        content_sha256: page.content_sha256,
      },
    ]),
  );
  const currentById = new Map(pages.map((page) => [page.page_id, page]));
  const delta = {
    schema_version: "catalog-delta.v2",
    contract: "qts-fact-catalog.v1",
    previous_bundle_fingerprint: bundleFixture.bundle.bundle_fingerprint,
    bundle_fingerprint: fingerprint,
    changed: true,
    catalog_root: bundleFixture.bundle.catalog_root,
    environment: "prod",
    roots: graph.roots,
    known_root_cause_candidates: graph.knownRootCauseCandidates,
    current_page_manifest: graph.pages,
    edges: graph.edges,
    unresolved_references: [],
    closure_status: graph.closureStatus,
    closure_complete: true,
    reference_extractor_version: EXTRACTOR_VERSION,
    changes: {
      added: [currentById.get(ADDED_ID)],
      updated: [
        {
          previous: previousById.get(SOURCE_ID),
          current: currentById.get(SOURCE_ID),
        },
      ],
      removed: [previousById.get(REMOVED_ID)],
      unchanged: [previousById.get(SERVICE_ID), previousById.get(KRC_ID)],
    },
    freshness_proof: signProof({
      signer,
      challenge: input.challenge,
      pages,
      fingerprint,
    }),
  };
  return { input, delta };
}

function result(structuredContent) {
  return {
    content: [{ type: "text", text: "Catalog v2 result" }],
    structuredContent,
  };
}

test("accepts a signed Catalog bundle v2 and optional pinned key", () => {
  const fixture = createBundle();

  assert.equal(
    validateCatalogV2ToolResult(
      "resolve_catalog_bundle_v2",
      fixture.input,
      result(fixture.bundle),
      {
        trustedPublicKeys: {
          [fixture.signer.keyId]: fixture.signer.publicKey,
        },
      },
    ).structuredContent,
    fixture.bundle,
  );
});

test("rejects Markdown, manifest, fingerprint, signature, and KRC tampering", () => {
  for (const tamper of [
    "markdown",
    "manifest",
    "fingerprint",
    "signature",
    "candidate",
  ]) {
    const fixture = createBundle();
    if (tamper === "markdown") {
      fixture.bundle.pages[0].markdown += "\ntampered";
    } else if (tamper === "manifest") {
      fixture.bundle.freshness_proof.page_manifest =
        fixture.bundle.freshness_proof.page_manifest.slice(1);
    } else if (tamper === "fingerprint") {
      fixture.bundle.bundle_fingerprint = "f".repeat(64);
    } else if (tamper === "signature") {
      fixture.bundle.freshness_proof.signature = "A".repeat(86);
    } else {
      fixture.bundle.known_root_cause_candidates[0].affected_entities = [
        "service/unrelated",
      ];
    }

    assert.throws(
      () =>
        validateCatalogV2ToolResult(
          "resolve_catalog_bundle_v2",
          fixture.input,
          result(fixture.bundle),
        ),
      { name: "CatalogV2ValidationError" },
      tamper,
    );
  }
});

test("requires configured pins and supports a rotation window", () => {
  const oldSigner = createSigner("catalog-ed25519-old");
  const currentSigner = createSigner("catalog-ed25519-current");
  const fixture = createBundle(oldSigner);

  assert.doesNotThrow(() =>
    validateCatalogV2ToolResult(
      "resolve_catalog_bundle_v2",
      fixture.input,
      result(fixture.bundle),
      {
        trustedPublicKeys: {
          [oldSigner.keyId]: oldSigner.publicKey,
          [currentSigner.keyId]: currentSigner.publicKey,
        },
      },
    ),
  );
  assert.throws(
    () =>
      validateCatalogV2ToolResult(
        "resolve_catalog_bundle_v2",
        fixture.input,
        result(fixture.bundle),
        {
          trustedPublicKeys: {
            [currentSigner.keyId]: currentSigner.publicKey,
          },
        },
      ),
    /not pinned/,
  );
});

test("rejects a correctly signed proof outside the trusted execution budget", () => {
  const fixture = createBundle();
  fixture.bundle.freshness_proof = signProof({
    signer: fixture.signer,
    challenge: fixture.input.challenge,
    pages: fixture.bundle.pages,
    fingerprint: fixture.bundle.bundle_fingerprint,
    resolutionElapsedMs: 10_001,
  });

  assert.throws(
    () =>
      validateCatalogV2ToolResult(
        "resolve_catalog_bundle_v2",
        fixture.input,
        result(fixture.bundle),
      ),
    /resolution_elapsed_ms/,
  );
});

test("accepts a complete mixed Delta including same-timestamp hash changes", () => {
  const bundleFixture = createBundle();
  const deltaFixture = createDelta(bundleFixture);

  validateCatalogV2ToolInput("resolve_catalog_delta_v2", deltaFixture.input);
  assert.doesNotThrow(() =>
    validateCatalogV2ToolResult(
      "resolve_catalog_delta_v2",
      deltaFixture.input,
      result(deltaFixture.delta),
    ),
  );
  assert.equal(
    deltaFixture.delta.changes.updated[0].previous.updated_at,
    UPDATED_AT,
  );
  assert.equal(
    deltaFixture.delta.changes.updated[0].current.updated_at,
    UPDATED_AT,
  );
  assert.notEqual(
    deltaFixture.delta.changes.updated[0].previous.content_sha256,
    deltaFixture.delta.changes.updated[0].current.content_sha256,
  );
});

test("rejects incomplete Delta partitions and an unverified previous proof", () => {
  const bundleFixture = createBundle();
  const incomplete = createDelta(bundleFixture);
  incomplete.delta.changes.unchanged.pop();
  assert.throws(
    () =>
      validateCatalogV2ToolResult(
        "resolve_catalog_delta_v2",
        incomplete.input,
        result(incomplete.delta),
      ),
    /partitions/,
  );

  const forged = createDelta(createBundle());
  forged.input.previous.freshnessProof.signature = "A".repeat(86);
  assert.throws(
    () => validateCatalogV2ToolInput("resolve_catalog_delta_v2", forged.input),
    /signature/,
  );
});
