"use strict";

const {
  createHash,
  createPublicKey,
  verify: verifySignature,
} = require("node:crypto");

const QTS_FACT_CATALOG_CONTRACT = "qts-fact-catalog.v1";
const CATALOG_BUNDLE_V2_SCHEMA_VERSION = "catalog-bundle.v2";
const CATALOG_DELTA_V2_SCHEMA_VERSION = "catalog-delta.v2";
const CATALOG_FRESHNESS_V2_SCHEMA_VERSION = "catalog-freshness-proof.v2";
const CATALOG_REFERENCE_EXTRACTOR_VERSION = "qts-fact-catalog-extractor.v2.0.0";
const CATALOG_SIGNATURE_ALGORITHM = "ed25519";
const CATALOG_PUBLIC_KEY_FORMAT = "spki-der-base64url";
const CATALOG_V2_TOOLS = Object.freeze([
  "resolve_catalog_bundle_v2",
  "resolve_catalog_delta_v2",
]);
const MAX_ROOTS = 32;
const MAX_PAGES = 512;
const MAX_EDGES = 4_096;
const MAX_PAGE_MARKDOWN_BYTES = 1024 * 1024;
const MAX_RESOLUTION_ELAPSED_MS = 10_000;
const MIN_CHALLENGE_BYTES = 16;
const MAX_CHALLENGE_BYTES = 128;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROOT_REASONS = new Set([
  "missing_or_not_accessible",
  "ambiguous_identity",
  "malformed_catalog_page",
  "unsupported_catalog_document",
]);
const REFERENCE_REASONS = new Set([
  "missing_or_not_accessible",
  "ambiguous_identity",
  "malformed_catalog_page",
  "unsupported_catalog_document",
  "invalid_reference",
  "reverse_validation_failed",
]);
const SUPPORTED_SCHEMAS = new Map([
  ["service_profile", new Set(["service-profile.v2"])],
  ["infrastructure_profile", new Set(["infrastructure-profile.v2"])],
  ["gateway_route", new Set(["gateway-route.v1"])],
  ["fact_source_profile", new Set(["fact-source-profile.v2"])],
  ["query_profile_set", new Set(["query-profile-set.v1"])],
  ["known_root_cause", new Set(["known-root-cause.v1"])],
]);

class CatalogV2ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogV2ValidationError";
  }
}

function validateCatalogV2ToolInput(name, args, options = {}) {
  if (!CATALOG_V2_TOOLS.includes(name)) return;
  assertExactKeys(
    args,
    name === "resolve_catalog_delta_v2"
      ? [
          "contract",
          "catalogRootPageId",
          "environment",
          "roots",
          "challenge",
          "previous",
        ]
      : ["contract", "catalogRootPageId", "environment", "roots", "challenge"],
    "Catalog v2 arguments",
  );
  if (args.contract !== QTS_FACT_CATALOG_CONTRACT) {
    fail(`contract must be ${QTS_FACT_CATALOG_CONTRACT}`);
  }
  assertUuid(args.catalogRootPageId, "catalogRootPageId");
  if (
    typeof args.environment !== "string" ||
    !ENVIRONMENT_PATTERN.test(args.environment)
  ) {
    fail("environment is invalid");
  }
  assertChallenge(args.challenge);
  if (
    !Array.isArray(args.roots) ||
    args.roots.length === 0 ||
    args.roots.length > MAX_ROOTS
  ) {
    fail(`roots must contain 1-${MAX_ROOTS} selectors`);
  }
  args.roots.forEach(validateInputRootSelector);
  assertCanonicalOrder(
    canonicalRequestedRoots(args.roots),
    "Catalog requested roots",
  );

  if (name === "resolve_catalog_delta_v2") {
    validatePrevious(args, options);
  }
}

function validateCatalogV2ToolResult(name, args, result, options = {}) {
  if (!CATALOG_V2_TOOLS.includes(name)) return result;
  validateCatalogV2ToolInput(name, args, options);
  assertObject(result, "Catalog v2 tool result");
  validateSummaryContent(result);
  assertObject(result.structuredContent, "Catalog v2 structuredContent");
  if (name === "resolve_catalog_bundle_v2") {
    validateBundleV2(args, result.structuredContent, options);
  } else {
    validateDeltaV2(args, result.structuredContent, options);
  }
  return result;
}

function validateBundleV2(args, bundle, options = {}) {
  assertExactKeys(
    bundle,
    [
      "schema_version",
      "contract",
      "catalog_root",
      "environment",
      "roots",
      "known_root_cause_candidates",
      "pages",
      "edges",
      "unresolved_references",
      "closure_status",
      "closure_complete",
      "reference_extractor_version",
      "bundle_fingerprint",
      "freshness_proof",
    ],
    "Catalog bundle v2",
  );
  if (bundle.schema_version !== CATALOG_BUNDLE_V2_SCHEMA_VERSION) {
    fail("Catalog bundle v2 schema_version is unsupported");
  }
  validateCommonEnvelope(args, bundle);
  validateExtractorVersion(bundle.reference_extractor_version);
  if (!Array.isArray(bundle.pages) || bundle.pages.length > MAX_PAGES) {
    fail(`Catalog bundle v2 pages must contain at most ${MAX_PAGES} items`);
  }
  const pages = bundle.pages.map(validateFullPage);
  assertUnique(
    pages.map((page) => page.page_id),
    "Catalog page IDs",
  );
  assertPageIdOrder(pages, (page) => page.page_id, "Catalog pages");
  const manifest = pageManifest(pages);
  const pageIds = new Set(manifest.map((page) => page.page_id));
  const pagesById = new Map(pages.map((page) => [page.page_id, page]));
  const roots = validateRoots(bundle.roots, pageIds, pagesById);
  const resolvedRootEntities = new Set(
    roots
      .filter((root) => root.status === "resolved")
      .map((root) => root.entity_id),
  );
  const candidates = validateCandidates(
    bundle.known_root_cause_candidates,
    pageIds,
    pagesById,
    bundle.environment,
    resolvedRootEntities,
  );
  const edges = validateEdges(bundle.edges, pageIds);
  const unresolved = validateUnresolvedReferences(
    bundle.unresolved_references,
    pageIds,
  );
  const closureStatus = validateClosure(
    bundle.closure_status,
    bundle.closure_complete,
    roots,
    unresolved,
  );
  const expectedFingerprint = computeBundleV2Fingerprint({
    catalogRootPageId: bundle.catalog_root.page_id,
    environment: bundle.environment,
    roots,
    knownRootCauseCandidates: candidates,
    pages: manifest,
    edges,
    unresolvedReferences: unresolved,
    closureStatus,
  });
  if (bundle.bundle_fingerprint !== expectedFingerprint) {
    fail("Catalog bundle v2 fingerprint does not match its content");
  }
  const proof = validateFreshnessProofV2(
    args,
    bundle.freshness_proof,
    manifest,
    expectedFingerprint,
    options,
  );
  validateFetchedAt(pages, proof);
  return bundle;
}

function validateDeltaV2(args, delta, options = {}) {
  assertExactKeys(
    delta,
    [
      "schema_version",
      "contract",
      "previous_bundle_fingerprint",
      "bundle_fingerprint",
      "changed",
      "catalog_root",
      "environment",
      "roots",
      "known_root_cause_candidates",
      "current_page_manifest",
      "edges",
      "unresolved_references",
      "closure_status",
      "closure_complete",
      "reference_extractor_version",
      "changes",
      "freshness_proof",
    ],
    "Catalog delta v2",
  );
  if (delta.schema_version !== CATALOG_DELTA_V2_SCHEMA_VERSION) {
    fail("Catalog delta v2 schema_version is unsupported");
  }
  validateCommonEnvelope(args, delta);
  validateExtractorVersion(delta.reference_extractor_version);
  if (delta.previous_bundle_fingerprint !== args.previous.bundleFingerprint) {
    fail("Catalog delta v2 previous fingerprint does not match the request");
  }
  const manifest = validateManifest(delta.current_page_manifest);
  const pageIds = new Set(manifest.map((page) => page.page_id));
  const roots = validateRoots(delta.roots, pageIds);
  const resolvedRootEntities = new Set(
    roots
      .filter((root) => root.status === "resolved")
      .map((root) => root.entity_id),
  );
  const candidates = validateCandidates(
    delta.known_root_cause_candidates,
    pageIds,
    undefined,
    delta.environment,
    resolvedRootEntities,
  );
  const edges = validateEdges(delta.edges, pageIds);
  const unresolved = validateUnresolvedReferences(
    delta.unresolved_references,
    pageIds,
  );
  const closureStatus = validateClosure(
    delta.closure_status,
    delta.closure_complete,
    roots,
    unresolved,
  );
  const expectedFingerprint = computeBundleV2Fingerprint({
    catalogRootPageId: delta.catalog_root.page_id,
    environment: delta.environment,
    roots,
    knownRootCauseCandidates: candidates,
    pages: manifest,
    edges,
    unresolvedReferences: unresolved,
    closureStatus,
  });
  if (delta.bundle_fingerprint !== expectedFingerprint) {
    fail("Catalog delta v2 fingerprint does not match its current manifest");
  }
  const proof = validateFreshnessProofV2(
    args,
    delta.freshness_proof,
    manifest,
    expectedFingerprint,
    options,
  );
  const changedPages = validateDeltaChanges(
    args.previous.pages,
    manifest,
    delta.changes,
  );
  validateFetchedAt(changedPages, proof);
  const hasPageChanges =
    delta.changes.added.length > 0 ||
    delta.changes.updated.length > 0 ||
    delta.changes.removed.length > 0;
  const expectedChanged =
    args.previous.bundleFingerprint !== delta.bundle_fingerprint ||
    hasPageChanges;
  if (delta.changed !== expectedChanged) {
    fail("Catalog delta v2 changed flag is inconsistent");
  }
  return delta;
}

function validatePrevious(args, options) {
  assertExactKeys(
    args.previous,
    ["bundleFingerprint", "pages", "freshnessProof"],
    "Catalog previous state",
  );
  assertSha256(args.previous.bundleFingerprint, "previous bundle fingerprint");
  if (!Array.isArray(args.previous.pages)) {
    fail("previous.pages must be an array");
  }
  if (args.previous.pages.length > MAX_PAGES) {
    fail(`previous.pages must contain at most ${MAX_PAGES} items`);
  }
  const manifest = args.previous.pages.map((page) => {
    assertExactKeys(
      page,
      ["pageId", "updatedAt", "contentSha256"],
      "previous page",
    );
    assertUuid(page.pageId, "previous.pageId");
    assertIsoTimestamp(page.updatedAt, "previous.updatedAt");
    assertSha256(page.contentSha256, "previous.contentSha256");
    return {
      page_id: page.pageId,
      updated_at: page.updatedAt,
      content_sha256: page.contentSha256,
    };
  });
  assertUnique(
    manifest.map((page) => page.page_id),
    "previous page IDs",
  );
  assertPageIdOrder(manifest, (page) => page.page_id, "previous pages");
  const proof = validateFreshnessProofV2(
    args,
    args.previous.freshnessProof,
    manifest,
    args.previous.bundleFingerprint,
    options,
    { previous: true },
  );
  if (proof.challenge === args.challenge) {
    fail("Delta challenge must differ from the previous proof challenge");
  }
}

function validateCommonEnvelope(args, value) {
  if (value.contract !== QTS_FACT_CATALOG_CONTRACT) {
    fail("Catalog response contract is unsupported");
  }
  if (value.environment !== args.environment) {
    fail("Catalog response environment does not match the request");
  }
  assertExactKeys(
    value.catalog_root,
    ["page_id", "title", "space_id", "updated_at"],
    "catalog_root",
  );
  assertUuid(value.catalog_root.page_id, "catalog_root.page_id");
  if (value.catalog_root.page_id !== args.catalogRootPageId) {
    fail("Catalog root page does not match the request");
  }
  if (value.catalog_root.title !== null) {
    assertCanonicalString(value.catalog_root.title, "catalog_root.title");
  }
  assertUuid(value.catalog_root.space_id, "catalog_root.space_id");
  assertIsoTimestamp(value.catalog_root.updated_at, "catalog_root.updated_at");
}

function validateRoots(values, pageIds, pagesById) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > MAX_ROOTS
  ) {
    fail(`Catalog roots must contain 1-${MAX_ROOTS} items`);
  }
  values.forEach((root) => {
    assertObject(root, "Catalog root result");
    validateOutputRootSelector(root.selector);
    if (root.status === "resolved") {
      assertExactKeys(
        root,
        ["selector", "status", "page_id", "document_type", "entity_id"],
        "resolved Catalog root",
      );
      assertUuid(root.page_id, "Catalog root page_id");
      assertCanonicalString(root.document_type, "Catalog root document_type");
      assertCanonicalString(root.entity_id, "Catalog root entity_id");
      if (!pageIds.has(root.page_id)) {
        fail("Resolved Catalog root is absent from the page manifest");
      }
      const page = pagesById?.get(root.page_id);
      if (
        page &&
        (page.front_matter.document_type !== root.document_type ||
          page.front_matter.entity_id !== root.entity_id)
      ) {
        fail("Resolved Catalog root identity does not match its page");
      }
    } else if (root.status === "unresolved") {
      assertExactKeys(
        root,
        ["selector", "status", "reason"],
        "unresolved Catalog root",
      );
      if (!ROOT_REASONS.has(root.reason)) {
        fail("Catalog root unresolved reason is unsupported");
      }
    } else {
      fail("Catalog root status is invalid");
    }
  });
  assertCanonicalOrder(values, "Catalog roots");
  assertUnique(values.map(stableStringify), "Catalog roots");
  return values;
}

function validateCandidates(
  values,
  pageIds,
  pagesById,
  environment,
  resolvedRootEntities,
) {
  if (!Array.isArray(values) || values.length > MAX_PAGES) {
    fail(`Catalog KRC candidates must contain at most ${MAX_PAGES} items`);
  }
  values.forEach((candidate) => {
    assertExactKeys(
      candidate,
      [
        "page_id",
        "document_type",
        "entity_id",
        "affected_entities",
        "environment_scope",
        "selection_reason",
      ],
      "Catalog KRC candidate",
    );
    assertUuid(candidate.page_id, "Catalog KRC page_id");
    if (candidate.document_type !== "known_root_cause") {
      fail("Catalog KRC document_type is invalid");
    }
    assertCanonicalString(candidate.entity_id, "Catalog KRC entity_id");
    validateCanonicalStringArray(
      candidate.affected_entities,
      "Catalog KRC affected_entities",
    );
    validateCanonicalStringArray(
      candidate.environment_scope,
      "Catalog KRC environment_scope",
    );
    assertCanonicalString(candidate.selection_reason, "Catalog KRC reason");
    if (!pageIds.has(candidate.page_id)) {
      fail("Catalog KRC candidate page is absent from the current manifest");
    }
    if (
      !candidate.environment_scope.includes(environment) &&
      !candidate.environment_scope.includes("*") &&
      !candidate.environment_scope.includes("all")
    ) {
      fail("Catalog KRC candidate does not match the response environment");
    }
    if (
      !candidate.affected_entities.some((entityId) =>
        resolvedRootEntities.has(entityId),
      )
    ) {
      fail("Catalog KRC candidate does not match a resolved root entity");
    }
    const page = pagesById?.get(candidate.page_id);
    if (
      page &&
      (page.front_matter.document_type !== "known_root_cause" ||
        page.front_matter.entity_id !== candidate.entity_id ||
        page.front_matter.status !== "active" ||
        !isObject(page.front_matter.verification) ||
        page.front_matter.verification.status !== "confirmed")
    ) {
      fail("Catalog KRC candidate does not match its confirmed page identity");
    }
  });
  assertCanonicalOrder(values, "Catalog KRC candidates");
  assertUnique(
    values.map((candidate) => candidate.page_id),
    "Catalog KRC IDs",
  );
  return values;
}

function validateFullPage(page) {
  assertExactKeys(
    page,
    [
      "page_id",
      "title",
      "parent_page_id",
      "space_id",
      "updated_at",
      "content_sha256",
      "fetched_at",
      "front_matter",
      "markdown",
    ],
    "Catalog page",
  );
  assertUuid(page.page_id, "Catalog page_id");
  if (page.title !== null) assertCanonicalString(page.title, "Catalog title");
  if (page.parent_page_id !== null) {
    assertUuid(page.parent_page_id, "Catalog parent_page_id");
  }
  assertUuid(page.space_id, "Catalog space_id");
  assertIsoTimestamp(page.updated_at, "Catalog updated_at");
  assertIsoTimestamp(page.fetched_at, "Catalog fetched_at");
  assertSha256(page.content_sha256, "Catalog content_sha256");
  if (
    typeof page.markdown !== "string" ||
    Buffer.byteLength(page.markdown, "utf8") > MAX_PAGE_MARKDOWN_BYTES
  ) {
    fail(`Catalog Markdown exceeds ${MAX_PAGE_MARKDOWN_BYTES} bytes`);
  }
  if (sha256(page.markdown) !== page.content_sha256) {
    fail("Catalog page content_sha256 does not match Markdown");
  }
  assertObject(page.front_matter, "Catalog front_matter");
  assertCanonicalString(
    page.front_matter.document_type,
    "Catalog front_matter.document_type",
  );
  assertCanonicalString(
    page.front_matter.schema_version,
    "Catalog front_matter.schema_version",
  );
  assertCanonicalString(
    page.front_matter.entity_id,
    "Catalog front_matter.entity_id",
  );
  if (
    !SUPPORTED_SCHEMAS.get(page.front_matter.document_type)?.has(
      page.front_matter.schema_version,
    )
  ) {
    fail("Catalog page schema is unsupported");
  }
  return page;
}

function validateEdges(values, pageIds) {
  if (!Array.isArray(values) || values.length > MAX_EDGES) {
    fail(`Catalog edges must contain at most ${MAX_EDGES} items`);
  }
  values.forEach((edge) => {
    assertExactKeys(
      edge,
      ["from_page_id", "to_page_id", "relation", "target"],
      "Catalog edge",
    );
    assertUuid(edge.from_page_id, "Catalog edge from_page_id");
    assertUuid(edge.to_page_id, "Catalog edge to_page_id");
    assertCanonicalString(edge.relation, "Catalog edge relation");
    validateTarget(edge.target, false);
    if (!pageIds.has(edge.from_page_id) || !pageIds.has(edge.to_page_id)) {
      fail("Catalog edge endpoint is absent from the current manifest");
    }
  });
  assertCanonicalOrder(values, "Catalog edges");
  assertUnique(values.map(stableStringify), "Catalog edges");
  return values;
}

function validateUnresolvedReferences(values, pageIds) {
  if (!Array.isArray(values) || values.length > MAX_EDGES) {
    fail(
      `Catalog unresolved references must contain at most ${MAX_EDGES} items`,
    );
  }
  values.forEach((reference) => {
    assertExactKeys(
      reference,
      ["from_page_id", "relation", "target", "reason"],
      "Catalog unresolved reference",
    );
    assertUuid(reference.from_page_id, "Catalog unresolved from_page_id");
    assertCanonicalString(reference.relation, "Catalog unresolved relation");
    validateTarget(reference.target, true);
    if (!REFERENCE_REASONS.has(reference.reason)) {
      fail("Catalog unresolved reference reason is unsupported");
    }
    if (!pageIds.has(reference.from_page_id)) {
      fail("Catalog unresolved source is absent from the current manifest");
    }
  });
  assertCanonicalOrder(values, "Catalog unresolved references");
  assertUnique(values.map(stableStringify), "Catalog unresolved references");
  return values;
}

function validateTarget(target, allowEmpty) {
  assertAllowedKeys(
    target,
    ["document_type", "entity_id", "query_profile_id"],
    "Catalog reference target",
  );
  if (target.document_type !== undefined) {
    assertCanonicalString(target.document_type, "Catalog target document_type");
  }
  if (target.entity_id !== undefined) {
    assertCanonicalString(target.entity_id, "Catalog target entity_id");
  }
  if (target.query_profile_id !== undefined) {
    assertCanonicalString(
      target.query_profile_id,
      "Catalog target query_profile_id",
    );
  }
  if (!allowEmpty && !target.document_type) {
    fail("Catalog edge target requires document_type");
  }
}

function validateClosure(status, complete, roots, unresolved) {
  assertExactKeys(
    status,
    [
      "roots_resolved",
      "reference_fields_scanned",
      "required_targets_resolved",
      "unresolved_references_empty",
      "known_root_cause_discovery_complete",
    ],
    "Catalog closure status",
  );
  for (const [name, value] of Object.entries(status)) {
    if (typeof value !== "boolean") fail(`Catalog closure ${name} is invalid`);
  }
  const expected = {
    roots_resolved: roots.every((root) => root.status === "resolved"),
    reference_fields_scanned: status.reference_fields_scanned,
    required_targets_resolved: unresolved.length === 0,
    unresolved_references_empty: unresolved.length === 0,
    known_root_cause_discovery_complete:
      status.known_root_cause_discovery_complete,
  };
  if (
    status.roots_resolved !== expected.roots_resolved ||
    status.required_targets_resolved !== expected.required_targets_resolved ||
    status.unresolved_references_empty !== expected.unresolved_references_empty
  ) {
    fail("Catalog closure status contradicts roots or unresolved references");
  }
  const expectedComplete = Object.values(status).every(Boolean);
  if (complete !== expectedComplete) {
    fail("Catalog closure_complete contradicts closure_status");
  }
  return status;
}

function validateFreshnessProofV2(
  args,
  proof,
  manifest,
  fingerprint,
  options = {},
  mode = {},
) {
  assertExactKeys(
    proof,
    [
      "schema_version",
      "signature_algorithm",
      "public_key_format",
      "public_key",
      "key_id",
      "challenge",
      "resolution_started_at",
      "verified_at",
      "resolution_elapsed_ms",
      "catalog_root_page_id",
      "environment",
      "authorization_context_sha256",
      "requested_roots",
      "isolation",
      "read_only",
      "page_manifest",
      "reference_extractor_version",
      "bundle_fingerprint",
      "signature",
    ],
    "Catalog freshness proof v2",
  );
  if (proof.schema_version !== CATALOG_FRESHNESS_V2_SCHEMA_VERSION) {
    fail("Catalog freshness proof v2 schema is unsupported");
  }
  if (proof.signature_algorithm !== CATALOG_SIGNATURE_ALGORITHM) {
    fail("Catalog freshness signature algorithm is unsupported");
  }
  if (proof.public_key_format !== CATALOG_PUBLIC_KEY_FORMAT) {
    fail("Catalog freshness public key format is unsupported");
  }
  if (typeof proof.key_id !== "string" || !KEY_ID_PATTERN.test(proof.key_id)) {
    fail("Catalog freshness key_id is invalid");
  }
  assertChallenge(proof.challenge);
  if (!mode.previous && proof.challenge !== args.challenge) {
    fail("Catalog freshness challenge does not match the request");
  }
  assertIsoTimestamp(
    proof.resolution_started_at,
    "Catalog resolution_started_at",
  );
  assertIsoTimestamp(proof.verified_at, "Catalog verified_at");
  if (Date.parse(proof.verified_at) < Date.parse(proof.resolution_started_at)) {
    fail("Catalog freshness timestamps are reversed");
  }
  if (
    !Number.isSafeInteger(proof.resolution_elapsed_ms) ||
    proof.resolution_elapsed_ms < 0 ||
    proof.resolution_elapsed_ms > MAX_RESOLUTION_ELAPSED_MS
  ) {
    fail("Catalog resolution_elapsed_ms is invalid");
  }
  assertUuid(proof.catalog_root_page_id, "Catalog proof root page ID");
  if (proof.catalog_root_page_id !== args.catalogRootPageId) {
    fail("Catalog proof root page does not match the request");
  }
  if (proof.environment !== args.environment) {
    fail("Catalog proof environment does not match the request");
  }
  assertSha256(
    proof.authorization_context_sha256,
    "Catalog authorization context",
  );
  if (
    stableStringify(proof.requested_roots) !==
    stableStringify(canonicalRequestedRoots(args.roots))
  ) {
    fail("Catalog proof requested roots do not match the request");
  }
  if (proof.isolation !== "repeatable_read" || proof.read_only !== true) {
    fail("Catalog proof does not attest a read-only repeatable-read snapshot");
  }
  validateExtractorVersion(proof.reference_extractor_version);
  if (proof.bundle_fingerprint !== fingerprint) {
    fail("Catalog proof fingerprint does not match the response");
  }
  const proofManifest = validateManifest(proof.page_manifest);
  if (stableStringify(proofManifest) !== stableStringify(manifest)) {
    fail("Catalog proof manifest does not match the response");
  }
  verifyFreshnessSignature(proof, options.trustedPublicKeys);
  return proof;
}

function verifyFreshnessSignature(proof, trustedPublicKeys) {
  assertCanonicalBase64Url(proof.public_key, "Catalog public key");
  assertCanonicalBase64Url(proof.signature, "Catalog signature");
  if (trustedPublicKeys !== undefined) {
    assertObject(trustedPublicKeys, "Catalog trusted public keys");
    const pinned = trustedPublicKeys[proof.key_id];
    if (typeof pinned !== "string" || pinned !== proof.public_key) {
      fail("Catalog signing key is not pinned for this profile");
    }
  }
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(proof.public_key, "base64url"),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("Catalog public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("Catalog public key is not Ed25519");
  }
  const { signature, ...unsigned } = proof;
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(stableStringify(unsigned), "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) fail("Catalog freshness proof signature is invalid");
}

function validateDeltaChanges(previousPages, currentManifest, changes) {
  assertExactKeys(
    changes,
    ["added", "updated", "removed", "unchanged"],
    "Catalog delta changes",
  );
  for (const name of ["added", "updated", "removed", "unchanged"]) {
    if (!Array.isArray(changes[name]) || changes[name].length > MAX_PAGES) {
      fail(`Catalog delta ${name} is invalid`);
    }
  }
  const previous = previousPages.map((page) => ({
    page_id: page.pageId,
    updated_at: page.updatedAt,
    content_sha256: page.contentSha256,
  }));
  const previousById = new Map(previous.map((page) => [page.page_id, page]));
  const currentById = new Map(
    currentManifest.map((page) => [page.page_id, page]),
  );
  const classified = new Set();
  const fetchedPages = [];

  changes.added.forEach((page) => {
    const value = validateFullPage(page);
    classify(value.page_id, "added", classified);
    if (previousById.has(value.page_id) || !currentById.has(value.page_id)) {
      fail("Catalog delta added partition is inconsistent");
    }
    assertManifestMatchesPage(currentById.get(value.page_id), value);
    fetchedPages.push(value);
  });
  changes.updated.forEach((item) => {
    assertExactKeys(
      item,
      ["previous", "current"],
      "Catalog delta updated item",
    );
    const previousValue = validateManifestItem(
      item.previous,
      "Catalog delta updated previous",
    );
    const currentValue = validateFullPage(item.current);
    if (previousValue.page_id !== currentValue.page_id) {
      fail("Catalog delta updated item page IDs differ");
    }
    classify(currentValue.page_id, "updated", classified);
    if (
      stableStringify(previousById.get(currentValue.page_id)) !==
        stableStringify(previousValue) ||
      !currentById.has(currentValue.page_id)
    ) {
      fail("Catalog delta updated partition is inconsistent");
    }
    if (
      previousValue.updated_at === currentValue.updated_at &&
      previousValue.content_sha256 === currentValue.content_sha256
    ) {
      fail("Catalog delta updated item did not change");
    }
    assertManifestMatchesPage(
      currentById.get(currentValue.page_id),
      currentValue,
    );
    fetchedPages.push(currentValue);
  });
  changes.removed.forEach((item) => {
    const value = validateManifestItem(item, "Catalog delta removed item");
    classify(value.page_id, "removed", classified);
    if (
      stableStringify(previousById.get(value.page_id)) !==
        stableStringify(value) ||
      currentById.has(value.page_id)
    ) {
      fail("Catalog delta removed partition is inconsistent");
    }
  });
  changes.unchanged.forEach((item) => {
    const value = validateManifestItem(item, "Catalog delta unchanged item");
    classify(value.page_id, "unchanged", classified);
    if (
      stableStringify(previousById.get(value.page_id)) !==
        stableStringify(value) ||
      stableStringify(currentById.get(value.page_id)) !== stableStringify(value)
    ) {
      fail("Catalog delta unchanged partition is inconsistent");
    }
  });
  const union = new Set([...previousById.keys(), ...currentById.keys()]);
  if (classified.size !== union.size) {
    fail("Catalog delta partitions do not cover the previous/current union");
  }
  for (const pageId of union) {
    if (!classified.has(pageId)) {
      fail("Catalog delta partitions omit a page ID");
    }
  }
  assertPageIdOrder(changes.added, (page) => page.page_id, "added pages");
  assertPageIdOrder(
    changes.updated,
    (item) => item.current?.page_id,
    "updated pages",
  );
  assertPageIdOrder(changes.removed, (page) => page.page_id, "removed pages");
  assertPageIdOrder(
    changes.unchanged,
    (page) => page.page_id,
    "unchanged pages",
  );
  return fetchedPages;
}

function computeBundleV2Fingerprint(input) {
  return sha256(
    stableStringify({
      contract: QTS_FACT_CATALOG_CONTRACT,
      schema_version: CATALOG_BUNDLE_V2_SCHEMA_VERSION,
      catalog_root_page_id: input.catalogRootPageId,
      environment: input.environment,
      roots: sortCanonical(input.roots),
      known_root_cause_candidates: sortCanonical(
        input.knownRootCauseCandidates,
      ),
      page_manifest: sortCanonical(input.pages),
      edges: sortCanonical(input.edges),
      unresolved_references: sortCanonical(input.unresolvedReferences),
      closure_status: input.closureStatus,
      reference_extractor_version: CATALOG_REFERENCE_EXTRACTOR_VERSION,
    }),
  );
}

function pageManifest(pages) {
  return pages
    .map((page) => ({
      page_id: page.page_id,
      updated_at: page.updated_at,
      content_sha256: page.content_sha256,
    }))
    .sort((left, right) => compare(left.page_id, right.page_id));
}

function validateManifest(values) {
  if (!Array.isArray(values) || values.length > MAX_PAGES) {
    fail(`Catalog manifest must contain at most ${MAX_PAGES} items`);
  }
  const manifest = values.map((item) =>
    validateManifestItem(item, "Catalog manifest item"),
  );
  assertUnique(
    manifest.map((page) => page.page_id),
    "Catalog manifest page IDs",
  );
  assertPageIdOrder(manifest, (page) => page.page_id, "Catalog manifest");
  return manifest;
}

function validateManifestItem(item, name) {
  assertExactKeys(item, ["page_id", "updated_at", "content_sha256"], name);
  assertUuid(item.page_id, `${name}.page_id`);
  assertIsoTimestamp(item.updated_at, `${name}.updated_at`);
  assertSha256(item.content_sha256, `${name}.content_sha256`);
  return item;
}

function assertManifestMatchesPage(manifest, page) {
  if (
    !manifest ||
    manifest.updated_at !== page.updated_at ||
    manifest.content_sha256 !== page.content_sha256
  ) {
    fail("Catalog delta full page does not match the current manifest");
  }
}

function validateFetchedAt(pages, proof) {
  for (const page of pages) {
    const fetched = Date.parse(page.fetched_at);
    if (
      fetched < Date.parse(proof.resolution_started_at) - 5_000 ||
      fetched > Date.parse(proof.verified_at) + 5_000
    ) {
      fail("Catalog page fetched_at is outside the signed resolution window");
    }
  }
  if (
    pages.length > 1 &&
    new Set(pages.map((page) => page.fetched_at)).size !== 1
  ) {
    fail("Catalog pages were not fetched from one snapshot timestamp");
  }
}

function validateExtractorVersion(value) {
  if (value !== CATALOG_REFERENCE_EXTRACTOR_VERSION) {
    fail("Catalog reference extractor version is unsupported");
  }
}

function canonicalRequestedRoots(roots) {
  const unique = new Map();
  for (const root of roots) {
    const output =
      "pageId" in root
        ? { page_id: root.pageId }
        : { document_type: root.documentType, entity_id: root.entityId };
    unique.set(stableStringify(output), output);
  }
  return sortCanonical([...unique.values()]);
}

function validateInputRootSelector(selector) {
  assertObject(selector, "Catalog root selector");
  const keys = Object.keys(selector).sort();
  if (stableStringify(keys) === stableStringify(["pageId"])) {
    assertUuid(selector.pageId, "Catalog root pageId");
    return;
  }
  if (
    stableStringify(keys) ===
    stableStringify(["documentType", "entityId"].sort())
  ) {
    assertCanonicalString(selector.documentType, "Catalog root documentType");
    assertCanonicalString(selector.entityId, "Catalog root entityId");
    return;
  }
  fail("Catalog root selector must contain pageId or documentType/entityId");
}

function validateOutputRootSelector(selector) {
  assertObject(selector, "Catalog output root selector");
  const keys = Object.keys(selector).sort();
  if (stableStringify(keys) === stableStringify(["page_id"])) {
    assertUuid(selector.page_id, "Catalog output root page_id");
    return;
  }
  if (
    stableStringify(keys) ===
    stableStringify(["document_type", "entity_id"].sort())
  ) {
    assertCanonicalString(
      selector.document_type,
      "Catalog output root document_type",
    );
    assertCanonicalString(selector.entity_id, "Catalog output root entity_id");
    return;
  }
  fail("Catalog output root selector is invalid");
}

function validateCanonicalStringArray(values, name) {
  if (!Array.isArray(values) || values.length === 0) {
    fail(`${name} must be a non-empty array`);
  }
  values.forEach((value) => assertCanonicalString(value, name));
  assertUnique(values, name);
  const sorted = [...values].sort(compare);
  if (stableStringify(values) !== stableStringify(sorted)) {
    fail(`${name} is not canonically ordered`);
  }
}

function validateSummaryContent(result) {
  if (
    !Array.isArray(result.content) ||
    result.content.length === 0 ||
    !result.content.every(
      (item) =>
        isObject(item) && item.type === "text" && typeof item.text === "string",
    )
  ) {
    fail("Catalog tool result content is invalid");
  }
}

function classify(pageId, partition, classified) {
  if (classified.has(pageId)) {
    fail(`Catalog delta page appears in more than one partition: ${partition}`);
  }
  classified.add(pageId);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      fail("Catalog value is not JSON serializable");
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sortCanonical(items) {
  return [...items].sort((left, right) =>
    compare(stableStringify(left), stableStringify(right)),
  );
}

function assertCanonicalOrder(items, name) {
  if (stableStringify(items) !== stableStringify(sortCanonical(items))) {
    fail(`${name} is not canonically ordered`);
  }
}

function assertPageIdOrder(items, getPageId, name) {
  const pageIds = items.map(getPageId);
  if (pageIds.some((pageId) => typeof pageId !== "string")) {
    fail(`${name} contain an invalid page ID`);
  }
  const sorted = [...pageIds].sort(compare);
  if (stableStringify(pageIds) !== stableStringify(sorted)) {
    fail(`${name} are not ordered by page_id`);
  }
}

function assertCanonicalBase64Url(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} must be base64url`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    fail(`${name} must be base64url`);
  }
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    fail(`${name} must be canonical base64url`);
  }
}

function assertChallenge(value) {
  if (typeof value !== "string") fail("challenge must be a string");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MIN_CHALLENGE_BYTES || bytes > MAX_CHALLENGE_BYTES) {
    fail(
      `challenge must be ${MIN_CHALLENGE_BYTES}-${MAX_CHALLENGE_BYTES} UTF-8 bytes`,
    );
  }
}

function assertSha256(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${name} must be a lowercase SHA-256 hex digest`);
  }
}

function assertUuid(value, name) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(`${name} must be a UUID`);
  }
}

function assertIsoTimestamp(value, name) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${name} must be a canonical ISO timestamp`);
  }
}

function assertCanonicalString(value, name) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    fail(`${name} must be a non-empty canonical string`);
  }
}

function assertUnique(values, name) {
  if (new Set(values).size !== values.length) {
    fail(`${name} contain duplicates`);
  }
}

function assertObject(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
}

function assertExactKeys(value, expected, name) {
  assertObject(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stableStringify(actual) !== stableStringify(wanted)) {
    fail(`${name} contains missing or unexpected fields`);
  }
}

function assertAllowedKeys(value, allowed, name) {
  assertObject(value, name);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail(`${name} contains unexpected fields`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new CatalogV2ValidationError(message);
}

module.exports = {
  CATALOG_BUNDLE_V2_SCHEMA_VERSION,
  CATALOG_DELTA_V2_SCHEMA_VERSION,
  CATALOG_FRESHNESS_V2_SCHEMA_VERSION,
  CATALOG_REFERENCE_EXTRACTOR_VERSION,
  CATALOG_V2_TOOLS,
  CatalogV2ValidationError,
  computeBundleV2Fingerprint,
  pageManifest,
  sha256,
  stableStringify,
  validateBundleV2,
  validateCatalogV2ToolInput,
  validateCatalogV2ToolResult,
  validateDeltaV2,
  validateFreshnessProofV2,
};
