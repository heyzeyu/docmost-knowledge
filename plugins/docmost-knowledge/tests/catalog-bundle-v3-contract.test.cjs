"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync, sign: signBytes } = require("node:crypto");
const test = require("node:test");

const {
  computeBundleV3Fingerprint,
  pageManifest,
  sha256,
  stableStringify,
  validateCatalogV3ToolInput,
  validateCatalogV3ToolResult,
} = require("../scripts/catalog-bundle-v3-contract.cjs");

const CATALOG_ROOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const KRC_ID = "33333333-3333-4333-8333-333333333333";
const REMOVED_ID = "44444444-4444-4444-8444-444444444444";
const ADDED_ID = "55555555-5555-4555-8555-555555555555";
const TICKET_ONE_ID = "66666666-6666-4666-8666-666666666666";
const TICKET_TWO_ID = "77777777-7777-4777-8777-777777777777";
const UPDATED_AT = "2026-08-21T00:00:00.000Z";
const RESOLUTION_BASE_MS = Date.now() - 1_000;
const RESOLUTION_STARTED_AT = new Date(RESOLUTION_BASE_MS).toISOString();
const FETCHED_AT = new Date(RESOLUTION_BASE_MS + 250).toISOString();
const VERIFIED_AT = new Date(RESOLUTION_BASE_MS + 500).toISOString();
const EXPIRES_AT = new Date(RESOLUTION_BASE_MS + 120_000).toISOString();
const EXTRACTOR_VERSION = "qts-fact-catalog-extractor.v3.0.0";

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
    front_matter_sha256: sha256(stableStringify(frontMatter)),
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

function signValue(unsigned, signer) {
  return {
    ...unsigned,
    signature: signBytes(
      null,
      Buffer.from(stableStringify(unsigned), "utf8"),
      signer.privateKey,
    ).toString("base64url"),
  };
}

function createTicket(
  signer,
  challenge = "diagnosis-unique-0001",
  ticketId = TICKET_ONE_ID,
  authorizationContextSha256 = "a".repeat(64),
) {
  return signValue(
    {
      schema_version: "catalog-resolution-ticket.v1",
      signature_algorithm: "ed25519",
      public_key_format: "spki-der-base64url",
      public_key: signer.publicKey,
      key_id: signer.keyId,
      ticket_id: ticketId,
      issued_at: RESOLUTION_STARTED_AT,
      expires_at: EXPIRES_AT,
      challenge,
      catalog_root_page_id: CATALOG_ROOT_ID,
      environment: "prod",
      authorization_context_sha256: authorizationContextSha256,
    },
    signer,
  );
}

function signProof({
  signer,
  ticket,
  pages,
  fingerprint,
  roots = [{ page_id: SERVICE_ID }],
  resolutionStartedAt = ticket.issued_at,
  verifiedAt = VERIFIED_AT,
  snapshotFetchedAt = FETCHED_AT,
  resolutionElapsedMs = Date.parse(verifiedAt) - Date.parse(resolutionStartedAt),
}) {
  const unsigned = {
    schema_version: "catalog-freshness-proof.v3",
    signature_algorithm: "ed25519",
    public_key_format: "spki-der-base64url",
    public_key: signer.publicKey,
    key_id: signer.keyId,
    resolution_ticket_id: ticket.ticket_id,
    challenge: ticket.challenge,
    resolution_started_at: resolutionStartedAt,
    verified_at: verifiedAt,
    resolution_elapsed_ms: resolutionElapsedMs,
    snapshot_fetched_at: snapshotFetchedAt,
    catalog_root_page_id: CATALOG_ROOT_ID,
    environment: "prod",
    authorization_context_sha256: ticket.authorization_context_sha256,
    requested_roots: roots,
    isolation: "repeatable_read",
    read_only: true,
    page_manifest: pageManifest(pages),
    reference_extractor_version: EXTRACTOR_VERSION,
    bundle_fingerprint: fingerprint,
  };
  return signValue(unsigned, signer);
}

function resignBundle(fixture) {
  const bundle = fixture.bundle;
  const fingerprint = computeBundleV3Fingerprint({
    catalogRootPageId: bundle.catalog_root.page_id,
    environment: bundle.environment,
    roots: bundle.roots,
    knownRootCauseCandidates: bundle.known_root_cause_candidates,
    pages: pageManifest(bundle.pages),
    edges: bundle.edges,
    unresolvedReferences: bundle.unresolved_references,
    closureStatus: bundle.closure_status,
  });
  bundle.bundle_fingerprint = fingerprint;
  bundle.freshness_proof = signProof({
    signer: fixture.signer,
    ticket: fixture.input.ticket,
    pages: bundle.pages,
    fingerprint,
  });
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
    a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0,
  );
  const ticket = createTicket(signer);
  const input = {
    contract: "qts-fact-catalog.v1",
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: "prod",
    roots: [{ pageId: SERVICE_ID }],
    ticket,
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
  const fingerprint = computeBundleV3Fingerprint(graph);
  const bundle = {
    schema_version: "catalog-bundle.v3",
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
      ticket,
      pages,
      fingerprint,
    }),
  };
  return { input, bundle, signer };
}

function createDelta(bundleFixture, signer = bundleFixture.signer) {
  const pages = createCurrentPages().sort((a, b) =>
    a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0,
  );
  const ticket = createTicket(
    signer,
    "diagnosis-unique-0002",
    TICKET_TWO_ID,
  );
  const input = {
    ...bundleFixture.input,
    ticket,
    previous: {
      bundleFingerprint: bundleFixture.bundle.bundle_fingerprint,
      pages: bundleFixture.bundle.pages.map((page) => ({
        pageId: page.page_id,
        updatedAt: page.updated_at,
        contentSha256: page.content_sha256,
        frontMatterSha256: page.front_matter_sha256,
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
  const fingerprint = computeBundleV3Fingerprint(graph);
  const previousById = new Map(
    bundleFixture.bundle.pages.map((page) => [
      page.page_id,
      {
        page_id: page.page_id,
        updated_at: page.updated_at,
        content_sha256: page.content_sha256,
        front_matter_sha256: page.front_matter_sha256,
      },
    ]),
  );
  const currentById = new Map(pages.map((page) => [page.page_id, page]));
  const delta = {
    schema_version: "catalog-delta.v3",
    contract: "qts-fact-catalog.v1",
    previous_bundle_fingerprint: bundleFixture.bundle.bundle_fingerprint,
    bundle_fingerprint: fingerprint,
    changed: true,
    catalog_root: bundleFixture.bundle.catalog_root,
    environment: "prod",
    roots: graph.roots,
    root_changes: {
      added: [],
      removed: [],
      unchanged: [{ page_id: SERVICE_ID }],
    },
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
      ticket,
      pages,
      fingerprint,
    }),
  };
  return { input, delta };
}

function previousFrom(bundle) {
  return {
    bundleFingerprint: bundle.bundle_fingerprint,
    pages: bundle.pages.map((page) => ({
      pageId: page.page_id,
      updatedAt: page.updated_at,
      contentSha256: page.content_sha256,
      frontMatterSha256: page.front_matter_sha256,
    })),
    freshnessProof: bundle.freshness_proof,
  };
}

function createUnchangedDelta(bundleFixture) {
  const ticket = createTicket(
    bundleFixture.signer,
    "diagnosis-unchanged-0002",
    TICKET_TWO_ID,
  );
  const input = {
    ...bundleFixture.input,
    ticket,
    previous: previousFrom(bundleFixture.bundle),
  };
  const manifest = pageManifest(bundleFixture.bundle.pages);
  return {
    input,
    delta: {
      schema_version: "catalog-delta.v3",
      contract: "qts-fact-catalog.v1",
      previous_bundle_fingerprint: bundleFixture.bundle.bundle_fingerprint,
      bundle_fingerprint: bundleFixture.bundle.bundle_fingerprint,
      changed: false,
      catalog_root: bundleFixture.bundle.catalog_root,
      environment: "prod",
      roots: bundleFixture.bundle.roots,
      root_changes: {
        added: [],
        removed: [],
        unchanged: [{ page_id: SERVICE_ID }],
      },
      known_root_cause_candidates:
        bundleFixture.bundle.known_root_cause_candidates,
      current_page_manifest: manifest,
      edges: bundleFixture.bundle.edges,
      unresolved_references: [],
      closure_status: bundleFixture.bundle.closure_status,
      closure_complete: true,
      reference_extractor_version: EXTRACTOR_VERSION,
      changes: { added: [], updated: [], removed: [], unchanged: manifest },
      freshness_proof: signProof({
        signer: bundleFixture.signer,
        ticket,
        pages: bundleFixture.bundle.pages,
        fingerprint: bundleFixture.bundle.bundle_fingerprint,
      }),
    },
  };
}

function createExpandedDelta(bundleFixture) {
  const addedPage = catalogPage(
    ADDED_ID,
    {
      document_type: "infrastructure_profile",
      schema_version: "infrastructure-profile.v2",
      entity_id: "infrastructure/shared",
    },
    `
document_type: infrastructure_profile
schema_version: infrastructure-profile.v2
entity_id: infrastructure/shared
`,
    "Shared infrastructure",
  );
  const pages = [...bundleFixture.bundle.pages, addedPage].sort((a, b) =>
    a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0,
  );
  const requestedRoots = [
    { page_id: SERVICE_ID },
    { page_id: ADDED_ID },
  ];
  const rootResults = canonicalSort([
    ...roots(),
    {
      selector: { page_id: ADDED_ID },
      status: "resolved",
      page_id: ADDED_ID,
      document_type: "infrastructure_profile",
      entity_id: "infrastructure/shared",
    },
  ]);
  const graph = {
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: "prod",
    roots: rootResults,
    knownRootCauseCandidates: candidates(),
    pages: pageManifest(pages),
    edges: baseEdges(),
    unresolvedReferences: [],
    closureStatus: closureStatus(),
  };
  const fingerprint = computeBundleV3Fingerprint(graph);
  const ticket = createTicket(
    bundleFixture.signer,
    "diagnosis-expanded-0002",
    TICKET_TWO_ID,
  );
  const input = {
    ...bundleFixture.input,
    roots: [{ pageId: SERVICE_ID }, { pageId: ADDED_ID }],
    ticket,
    previous: previousFrom(bundleFixture.bundle),
  };
  return {
    input,
    delta: {
      schema_version: "catalog-delta.v3",
      contract: "qts-fact-catalog.v1",
      previous_bundle_fingerprint: bundleFixture.bundle.bundle_fingerprint,
      bundle_fingerprint: fingerprint,
      changed: true,
      catalog_root: bundleFixture.bundle.catalog_root,
      environment: "prod",
      roots: rootResults,
      root_changes: {
        added: [{ page_id: ADDED_ID }],
        removed: [],
        unchanged: [{ page_id: SERVICE_ID }],
      },
      known_root_cause_candidates: candidates(),
      current_page_manifest: graph.pages,
      edges: graph.edges,
      unresolved_references: [],
      closure_status: graph.closureStatus,
      closure_complete: true,
      reference_extractor_version: EXTRACTOR_VERSION,
      changes: {
        added: [addedPage],
        updated: [],
        removed: [],
        unchanged: pageManifest(bundleFixture.bundle.pages),
      },
      freshness_proof: signProof({
        signer: bundleFixture.signer,
        ticket,
        pages,
        fingerprint,
        roots: requestedRoots,
      }),
    },
  };
}

function createPartialBundle(signer = createSigner()) {
  const basePages = createBasePages();
  const pages = [basePages[0], basePages[2]].sort((a, b) =>
    a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0,
  );
  const unresolved = [
    {
      from_page_id: SERVICE_ID,
      relation: "fact_sources",
      target: {
        document_type: "fact_source_profile",
        entity_id: "fact-source/tencent-tke",
      },
      reason: "missing_or_not_accessible",
    },
  ];
  const status = {
    roots_resolved: true,
    reference_fields_scanned: true,
    required_targets_resolved: false,
    unresolved_references_empty: false,
    known_root_cause_discovery_complete: true,
  };
  const edges = canonicalSort([
    baseEdges().find((edge) => edge.from_page_id === KRC_ID),
  ]);
  const graph = {
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: "prod",
    roots: roots(),
    knownRootCauseCandidates: candidates(),
    pages: pageManifest(pages),
    edges,
    unresolvedReferences: unresolved,
    closureStatus: status,
  };
  const fingerprint = computeBundleV3Fingerprint(graph);
  const ticket = createTicket(signer);
  const input = {
    contract: "qts-fact-catalog.v1",
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: "prod",
    roots: [{ pageId: SERVICE_ID }],
    ticket,
  };
  return {
    signer,
    input,
    bundle: {
      schema_version: "catalog-bundle.v3",
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
      edges,
      unresolved_references: unresolved,
      closure_status: status,
      closure_complete: false,
      reference_extractor_version: EXTRACTOR_VERSION,
      bundle_fingerprint: fingerprint,
      freshness_proof: signProof({ signer, ticket, pages, fingerprint }),
    },
  };
}

function result(structuredContent) {
  return {
    content: [{ type: "text", text: "Catalog v3 result" }],
    structuredContent,
  };
}

function trustedOptions(signer) {
  return {
    trustedPublicKeys: { [signer.keyId]: signer.publicKey },
  };
}

test("accepts a pinned signed Catalog resolution start ticket", () => {
  const signer = createSigner();
  const challenge = "diagnosis-ticket-unique-0001";
  const input = {
    contract: "qts-fact-catalog.v1",
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: "prod",
    challenge,
  };
  const ticket = createTicket(signer, challenge);
  assert.equal(
    validateCatalogV3ToolResult(
      "begin_catalog_resolution",
      input,
      result(ticket),
      trustedOptions(signer),
    ).structuredContent,
    ticket,
  );

  const mismatched = createTicket(signer, "different-ticket-challenge");
  assert.throws(
    () =>
      validateCatalogV3ToolResult(
        "begin_catalog_resolution",
        input,
        result(mismatched),
        trustedOptions(signer),
      ),
    /challenge does not match/,
  );
});

test("accepts a signed Catalog bundle v3 with a mandatory pinned key", () => {
  const fixture = createBundle();

  assert.equal(
    validateCatalogV3ToolResult(
      "resolve_catalog_bundle_v3",
      fixture.input,
      result(fixture.bundle),
      trustedOptions(fixture.signer),
    ).structuredContent,
    fixture.bundle,
  );
});

test("accepts a locally verified partial closure without forcing completeness", () => {
  const fixture = createPartialBundle();
  assert.doesNotThrow(() =>
    validateCatalogV3ToolResult(
      "resolve_catalog_bundle_v3",
      fixture.input,
      result(fixture.bundle),
      trustedOptions(fixture.signer),
    ),
  );
  assert.equal(fixture.bundle.closure_complete, false);
  assert.equal(fixture.bundle.unresolved_references.length, 1);
});

test("rejects Markdown, front matter, edge, closure, proof, and KRC tampering", () => {
  for (const tamper of [
    "markdown",
    "front_matter",
    "edge",
    "closure",
    "manifest",
    "fingerprint",
    "challenge",
    "signature",
    "candidate",
  ]) {
    const fixture = createBundle();
    if (tamper === "markdown") {
      fixture.bundle.pages[0].markdown += "\ntampered";
    } else if (tamper === "front_matter") {
      fixture.bundle.pages[0].front_matter.entity_id = "service/tampered";
    } else if (tamper === "edge") {
      fixture.bundle.edges[0].relation = "tampered_relation";
    } else if (tamper === "closure") {
      fixture.bundle.closure_complete = false;
    } else if (tamper === "manifest") {
      fixture.bundle.freshness_proof.page_manifest =
        fixture.bundle.freshness_proof.page_manifest.slice(1);
    } else if (tamper === "fingerprint") {
      fixture.bundle.bundle_fingerprint = "f".repeat(64);
    } else if (tamper === "challenge") {
      fixture.bundle.freshness_proof.challenge = "tampered-challenge-0001";
    } else if (tamper === "signature") {
      fixture.bundle.freshness_proof.signature = "A".repeat(86);
    } else {
      fixture.bundle.known_root_cause_candidates[0].affected_entities = [
        "service/unrelated",
      ];
    }

    assert.throws(
      () =>
        validateCatalogV3ToolResult(
          "resolve_catalog_bundle_v3",
          fixture.input,
          result(fixture.bundle),
          trustedOptions(fixture.signer),
        ),
      { name: "CatalogV3ValidationError" },
      tamper,
    );
  }
});

test("rejects missing, extra, duplicate, and identity-mismatched edges independently of the fingerprint", () => {
  for (const tamper of ["missing", "extra", "duplicate", "identity"]) {
    const fixture = createBundle();
    if (tamper === "missing") {
      fixture.bundle.edges = fixture.bundle.edges.slice(1);
    } else if (tamper === "extra") {
      fixture.bundle.edges = canonicalSort([
        ...fixture.bundle.edges,
        {
          from_page_id: SERVICE_ID,
          to_page_id: KRC_ID,
          relation: "unexpected_relation",
          target: {
            document_type: "known_root_cause",
            entity_id: "known-root-cause/neptune-timeout",
          },
        },
      ]);
    } else if (tamper === "duplicate") {
      fixture.bundle.edges = canonicalSort([
        ...fixture.bundle.edges,
        fixture.bundle.edges[0],
      ]);
    } else {
      fixture.bundle.edges[0] = {
        ...fixture.bundle.edges[0],
        to_page_id: KRC_ID,
      };
      fixture.bundle.edges = canonicalSort(fixture.bundle.edges);
    }
    resignBundle(fixture);

    assert.throws(
      () =>
        validateCatalogV3ToolResult(
          "resolve_catalog_bundle_v3",
          fixture.input,
          result(fixture.bundle),
          trustedOptions(fixture.signer),
        ),
      { name: "CatalogV3ValidationError" },
      tamper,
    );
  }
});

test("rejects duplicate requested roots before accepting a signed response", () => {
  const fixture = createBundle();
  fixture.input.roots = [
    { pageId: SERVICE_ID },
    { pageId: SERVICE_ID },
  ];
  assert.throws(
    () =>
      validateCatalogV3ToolInput(
        "resolve_catalog_bundle_v3",
        fixture.input,
        trustedOptions(fixture.signer),
      ),
    /duplicates/,
  );
});

test("requires configured pins and supports a rotation window", () => {
  const oldSigner = createSigner("catalog-ed25519-old");
  const currentSigner = createSigner("catalog-ed25519-current");
  const fixture = createBundle(oldSigner);

  assert.throws(
    () =>
      validateCatalogV3ToolResult(
        "resolve_catalog_bundle_v3",
        fixture.input,
        result(fixture.bundle),
      ),
    /requires profile catalogPublicKeys pins/,
  );

  assert.doesNotThrow(() =>
    validateCatalogV3ToolResult(
      "resolve_catalog_bundle_v3",
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
      validateCatalogV3ToolResult(
        "resolve_catalog_bundle_v3",
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

test("rejects a correctly signed proof with inconsistent elapsed time", () => {
  const fixture = createBundle();
  fixture.bundle.freshness_proof = signProof({
    signer: fixture.signer,
    ticket: fixture.input.ticket,
    pages: fixture.bundle.pages,
    fingerprint: fixture.bundle.bundle_fingerprint,
    resolutionElapsedMs: 10_001,
  });

  assert.throws(
    () =>
      validateCatalogV3ToolResult(
        "resolve_catalog_bundle_v3",
        fixture.input,
        result(fixture.bundle),
        trustedOptions(fixture.signer),
      ),
    /resolution_elapsed_ms/,
  );
});

test("rejects correctly signed reversed, future, and out-of-window timestamps", () => {
  for (const tamper of ["reversed", "future", "snapshot"]) {
    const fixture = createBundle();
    const startedAt = fixture.input.ticket.issued_at;
    let verifiedAt = VERIFIED_AT;
    let snapshotFetchedAt = FETCHED_AT;
    if (tamper === "reversed") {
      verifiedAt = new Date(Date.parse(startedAt) - 1).toISOString();
    } else if (tamper === "future") {
      verifiedAt = new Date(Date.now() + 10_000).toISOString();
      snapshotFetchedAt = new Date(Date.now() + 1_000).toISOString();
    } else {
      snapshotFetchedAt = new Date(Date.parse(startedAt) - 1).toISOString();
    }
    fixture.bundle.freshness_proof = signProof({
      signer: fixture.signer,
      ticket: fixture.input.ticket,
      pages: fixture.bundle.pages,
      fingerprint: fixture.bundle.bundle_fingerprint,
      verifiedAt,
      snapshotFetchedAt,
    });

    assert.throws(
      () =>
        validateCatalogV3ToolResult(
          "resolve_catalog_bundle_v3",
          fixture.input,
          result(fixture.bundle),
          trustedOptions(fixture.signer),
        ),
      { name: "CatalogV3ValidationError" },
      tamper,
    );
  }
});

test("accepts a complete mixed Delta including same-timestamp hash changes", () => {
  const bundleFixture = createBundle();
  const deltaFixture = createDelta(bundleFixture);
  const options = trustedOptions(bundleFixture.signer);

  validateCatalogV3ToolResult(
    "resolve_catalog_bundle_v3",
    bundleFixture.input,
    result(bundleFixture.bundle),
    options,
  );
  validateCatalogV3ToolInput(
    "resolve_catalog_delta_v3",
    deltaFixture.input,
    options,
  );
  assert.doesNotThrow(() =>
    validateCatalogV3ToolResult(
      "resolve_catalog_delta_v3",
      deltaFixture.input,
      result(deltaFixture.delta),
      options,
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

test("accepts a same-roots Delta with a complete unchanged partition", () => {
  const bundleFixture = createBundle();
  const deltaFixture = createUnchangedDelta(bundleFixture);
  const options = trustedOptions(bundleFixture.signer);
  validateCatalogV3ToolResult(
    "resolve_catalog_bundle_v3",
    bundleFixture.input,
    result(bundleFixture.bundle),
    options,
  );
  assert.doesNotThrow(() =>
    validateCatalogV3ToolResult(
      "resolve_catalog_delta_v3",
      deltaFixture.input,
      result(deltaFixture.delta),
      options,
    ),
  );
  assert.equal(deltaFixture.delta.changed, false);
  assert.equal(
    deltaFixture.delta.changes.unchanged.length,
    bundleFixture.bundle.pages.length,
  );
});

test("accepts roots expansion and rejects root_changes tampering", () => {
  const bundleFixture = createBundle();
  const expanded = createExpandedDelta(bundleFixture);
  const options = trustedOptions(bundleFixture.signer);
  validateCatalogV3ToolResult(
    "resolve_catalog_bundle_v3",
    bundleFixture.input,
    result(bundleFixture.bundle),
    options,
  );
  assert.doesNotThrow(() =>
    validateCatalogV3ToolResult(
      "resolve_catalog_delta_v3",
      expanded.input,
      result(expanded.delta),
      options,
    ),
  );
  assert.deepEqual(expanded.delta.root_changes.added, [
    { page_id: ADDED_ID },
  ]);
  assert.equal(expanded.delta.changes.added.length, 1);

  const tampered = createExpandedDelta(bundleFixture);
  tampered.delta.root_changes.added = [];
  assert.throws(
    () =>
      validateCatalogV3ToolResult(
        "resolve_catalog_delta_v3",
        tampered.input,
        result(tampered.delta),
        options,
      ),
    /root_changes/,
  );
});

test("rejects a prior proof from a different authorization context", () => {
  const bundleFixture = createBundle();
  const deltaFixture = createDelta(bundleFixture);
  deltaFixture.input.ticket = createTicket(
    bundleFixture.signer,
    "diagnosis-auth-context-0002",
    TICKET_TWO_ID,
    "b".repeat(64),
  );

  assert.throws(
    () =>
      validateCatalogV3ToolInput(
        "resolve_catalog_delta_v3",
        deltaFixture.input,
        trustedOptions(bundleFixture.signer),
      ),
    /authorization context is stale/,
  );
});

test("rejects incomplete Delta partitions and an unverified previous proof", () => {
  const bundleFixture = createBundle();
  const incomplete = createDelta(bundleFixture);
  const options = trustedOptions(bundleFixture.signer);
  validateCatalogV3ToolResult(
    "resolve_catalog_bundle_v3",
    bundleFixture.input,
    result(bundleFixture.bundle),
    options,
  );
  incomplete.delta.changes.unchanged.pop();
  assert.throws(
    () =>
      validateCatalogV3ToolResult(
        "resolve_catalog_delta_v3",
        incomplete.input,
        result(incomplete.delta),
        options,
      ),
    /partitions/,
  );

  const forgedBase = createBundle();
  const forged = createDelta(forgedBase);
  forged.input.previous.freshnessProof.signature = "A".repeat(86);
  assert.throws(
    () =>
      validateCatalogV3ToolInput(
        "resolve_catalog_delta_v3",
        forged.input,
        trustedOptions(forgedBase.signer),
      ),
    /signature/,
  );
});
