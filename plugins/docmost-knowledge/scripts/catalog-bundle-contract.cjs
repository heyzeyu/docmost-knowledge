"use strict";

const { createHash } = require("node:crypto");

const QTS_FACT_CATALOG_CONTRACT = "qts-fact-catalog.v1";
const CATALOG_BUNDLE_SCHEMA_VERSION = "catalog-bundle.v1";
const CATALOG_DELTA_SCHEMA_VERSION = "catalog-delta.v1";
const CATALOG_FRESHNESS_SCHEMA_VERSION = "catalog-freshness-proof.v1";
const CATALOG_TOOLS = Object.freeze([
  "resolve_catalog_bundle",
  "resolve_catalog_delta",
]);
const MAX_ROOTS = 32;
const MAX_PAGES = 512;
const MAX_EDGES = 4_096;
const MAX_PAGE_MARKDOWN_BYTES = 1024 * 1024;
const MIN_CHALLENGE_BYTES = 16;
const MAX_CHALLENGE_BYTES = 128;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ROOT_REASONS = new Set([
  "missing_or_not_accessible",
  "ambiguous_identity",
  "malformed_catalog_page",
  "unsupported_catalog_document",
]);
const REFERENCE_REASONS = new Set([
  "missing_or_not_accessible",
  "ambiguous_identity",
  "invalid_reference",
  "reverse_validation_failed",
]);

class CatalogValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

function validateCatalogToolInput(name, args) {
  if (!CATALOG_TOOLS.includes(name)) return;
  assertObject(args, "Catalog arguments");
  assertExactKeys(
    args,
    name === "resolve_catalog_delta"
      ? [
          "contract",
          "catalogRootPageId",
          "environment",
          "roots",
          "challenge",
          "previous",
        ]
      : ["contract", "catalogRootPageId", "environment", "roots", "challenge"],
    "Catalog arguments",
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
  for (const selector of args.roots) validateRootSelector(selector);

  if (name === "resolve_catalog_delta") {
    validatePrevious(args.previous);
  }
}

function validateCatalogToolResult(name, args, result) {
  if (!CATALOG_TOOLS.includes(name)) return result;
  validateCatalogToolInput(name, args);
  assertObject(result, "Catalog tool result");
  validateSummaryContent(result);
  assertObject(result.structuredContent, "Catalog structuredContent");
  if (name === "resolve_catalog_bundle") {
    validateBundle(args, result.structuredContent);
  } else {
    validateDelta(args, result.structuredContent);
  }
  return result;
}

function validateBundle(args, bundle) {
  assertExactKeys(
    bundle,
    [
      "schema_version",
      "contract",
      "catalog_root",
      "environment",
      "roots",
      "pages",
      "edges",
      "unresolved_references",
      "closure_complete",
      "bundle_fingerprint",
      "freshness_proof",
    ],
    "Catalog bundle",
  );
  if (bundle.schema_version !== CATALOG_BUNDLE_SCHEMA_VERSION) {
    fail("Catalog bundle schema_version is unsupported");
  }
  validateCommonEnvelope(args, bundle);
  if (!Array.isArray(bundle.pages) || bundle.pages.length > MAX_PAGES) {
    fail(`Catalog bundle pages must contain at most ${MAX_PAGES} items`);
  }
  const pages = bundle.pages.map((page) => validateFullPage(page));
  assertUnique(
    pages.map((page) => page.page_id),
    "Catalog page IDs",
  );
  assertPageIdOrder(bundle.pages, (page) => page.page_id, "Catalog pages");
  const manifest = pageManifest(pages);
  const pageIds = new Set(manifest.map((page) => page.page_id));
  const pagesById = new Map(pages.map((page) => [page.page_id, page]));
  validateGraph(bundle, pageIds, pagesById);
  validateRootsAgainstPages(bundle.roots, pageIds, pagesById);
  const expectedFingerprint = computeBundleFingerprint({
    catalogRootPageId: bundle.catalog_root.page_id,
    environment: bundle.environment,
    roots: bundle.roots,
    pages: manifest,
    edges: bundle.edges,
    unresolvedReferences: bundle.unresolved_references,
  });
  if (bundle.bundle_fingerprint !== expectedFingerprint) {
    fail("Catalog bundle fingerprint does not match its content");
  }
  validateFreshnessProof(
    args,
    bundle.freshness_proof,
    manifest,
    expectedFingerprint,
  );
}

function validateDelta(args, delta) {
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
      "current_page_manifest",
      "edges",
      "unresolved_references",
      "closure_complete",
      "changes",
      "freshness_proof",
    ],
    "Catalog delta",
  );
  if (delta.schema_version !== CATALOG_DELTA_SCHEMA_VERSION) {
    fail("Catalog delta schema_version is unsupported");
  }
  validateCommonEnvelope(args, delta);
  if (delta.previous_bundle_fingerprint !== args.previous.bundleFingerprint) {
    fail("Catalog delta previous fingerprint does not match the request");
  }
  if (!Array.isArray(delta.current_page_manifest)) {
    fail("Catalog delta current_page_manifest must be an array");
  }
  if (delta.current_page_manifest.length > MAX_PAGES) {
    fail(`Catalog delta manifest exceeds ${MAX_PAGES} pages`);
  }
  const manifest = delta.current_page_manifest.map((page) =>
    validateManifestItem(page, "current_page_manifest"),
  );
  assertUnique(
    manifest.map((page) => page.page_id),
    "Catalog manifest page IDs",
  );
  assertPageIdOrder(
    delta.current_page_manifest,
    (page) => page.page_id,
    "Catalog current manifest",
  );
  const pageIds = new Set(manifest.map((page) => page.page_id));
  validateGraph(delta, pageIds);
  validateRootsAgainstPages(delta.roots, pageIds);
  const expectedFingerprint = computeBundleFingerprint({
    catalogRootPageId: delta.catalog_root.page_id,
    environment: delta.environment,
    roots: delta.roots,
    pages: manifest,
    edges: delta.edges,
    unresolvedReferences: delta.unresolved_references,
  });
  if (delta.bundle_fingerprint !== expectedFingerprint) {
    fail("Catalog delta fingerprint does not match its current manifest");
  }
  validateFreshnessProof(
    args,
    delta.freshness_proof,
    manifest,
    expectedFingerprint,
  );
  validateDeltaChanges(args.previous.pages, manifest, delta.changes);

  const hasChanges =
    delta.changes.added.length > 0 ||
    delta.changes.updated.length > 0 ||
    delta.changes.removed.length > 0;
  const expectedChanged =
    args.previous.bundleFingerprint !== delta.bundle_fingerprint || hasChanges;
  if (delta.changed !== expectedChanged) {
    fail("Catalog delta changed flag is inconsistent");
  }
}

function validateCommonEnvelope(args, value) {
  if (value.contract !== QTS_FACT_CATALOG_CONTRACT) {
    fail("Catalog response contract is unsupported");
  }
  if (value.environment !== args.environment) {
    fail("Catalog response environment does not match the request");
  }
  validateCatalogRoot(value.catalog_root, args.catalogRootPageId);
  validateRoots(value.roots, args.roots);
  if (typeof value.closure_complete !== "boolean") {
    fail("Catalog closure_complete must be boolean");
  }
  if (!SHA256_PATTERN.test(value.bundle_fingerprint)) {
    fail("Catalog bundle_fingerprint is invalid");
  }
}

function validateCatalogRoot(root, expectedPageId) {
  assertObject(root, "catalog_root");
  assertExactKeys(
    root,
    ["page_id", "title", "space_id", "updated_at"],
    "catalog_root",
  );
  assertUuid(root.page_id, "catalog_root.page_id");
  if (root.page_id !== expectedPageId) {
    fail("catalog_root.page_id does not match the request");
  }
  if (root.title !== null && typeof root.title !== "string") {
    fail("catalog_root.title is invalid");
  }
  assertUuid(root.space_id, "catalog_root.space_id");
  assertIsoTimestamp(root.updated_at, "catalog_root.updated_at");
}

function validateRoots(roots, requestedRoots) {
  if (!Array.isArray(roots) || roots.length > MAX_ROOTS) {
    fail(`Catalog roots must contain at most ${MAX_ROOTS} items`);
  }
  assertCanonicalOrder(roots, "Catalog roots");
  const selectors = roots.map((root) => {
    assertObject(root, "Catalog root result");
    assertObject(root.selector, "Catalog root selector");
    const selector = validateOutputRootSelector(root.selector);
    if (root.status === "resolved") {
      assertExactKeys(
        root,
        ["selector", "status", "page_id", "document_type", "entity_id"],
        "resolved Catalog root",
      );
      assertUuid(root.page_id, "resolved root page_id");
      assertCanonicalString(root.document_type, "resolved root document_type");
      assertCanonicalString(root.entity_id, "resolved root entity_id");
      if ("page_id" in selector && root.page_id !== selector.page_id) {
        fail("A resolved Catalog root does not match its page selector");
      }
      if (
        "document_type" in selector &&
        (root.document_type !== selector.document_type ||
          root.entity_id !== selector.entity_id)
      ) {
        fail("A resolved Catalog root does not match its identity selector");
      }
    } else if (root.status === "unresolved") {
      assertExactKeys(
        root,
        ["selector", "status", "reason"],
        "unresolved Catalog root",
      );
      if (!ROOT_REASONS.has(root.reason)) {
        fail("Catalog root reason is unsupported");
      }
    } else {
      fail("Catalog root status is unsupported");
    }
    return selector;
  });
  assertUnique(selectors.map(stableStringify), "Catalog root selectors");
  const expectedSelectors = uniqueCanonical(
    requestedRoots.map(inputSelectorToOutput),
  );
  if (
    stableStringify(sortCanonical(selectors)) !==
    stableStringify(expectedSelectors)
  ) {
    fail("Catalog response roots do not match the requested selectors");
  }
}

function validateRootsAgainstPages(roots, pageIds, pagesById) {
  for (const root of roots) {
    if (root.status === "resolved" && !pageIds.has(root.page_id)) {
      fail("A resolved Catalog root is absent from the page manifest");
    }
    if (root.status !== "resolved" || !pagesById) continue;
    const page = pagesById.get(root.page_id);
    if (
      !page ||
      page.front_matter.document_type !== root.document_type ||
      page.front_matter.entity_id !== root.entity_id
    ) {
      fail("A resolved Catalog root does not match its page identity");
    }
  }
}

function validateGraph(value, pageIds, pagesById) {
  if (!Array.isArray(value.edges) || value.edges.length > MAX_EDGES) {
    fail(`Catalog edges must contain at most ${MAX_EDGES} items`);
  }
  assertCanonicalOrder(value.edges, "Catalog edges");
  assertUnique(value.edges.map(stableStringify), "Catalog edges");
  for (const edge of value.edges) {
    assertObject(edge, "Catalog edge");
    assertExactKeys(
      edge,
      ["from_page_id", "to_page_id", "relation", "target"],
      "Catalog edge",
    );
    if (!pageIds.has(edge.from_page_id) || !pageIds.has(edge.to_page_id)) {
      fail("Catalog edge references a page outside the closure");
    }
    assertCanonicalString(edge.relation, "Catalog edge relation");
    validateReferenceTarget(edge.target, true);
    const targetPage = pagesById?.get(edge.to_page_id);
    if (
      targetPage &&
      targetPage.front_matter.document_type !== edge.target.document_type
    ) {
      fail("Catalog edge target document type does not match its page");
    }
    if (
      targetPage &&
      edge.target.entity_id !== undefined &&
      targetPage.front_matter.entity_id !== edge.target.entity_id
    ) {
      fail("Catalog edge target entity does not match its page");
    }
    if (targetPage && edge.target.query_profile_id !== undefined) {
      const profiles = targetPage.front_matter.query_profiles;
      const profileMatches =
        Array.isArray(profiles) &&
        profiles.some(
          (profile) =>
            isObject(profile) &&
            profile.query_profile_id === edge.target.query_profile_id,
        );
      if (!profileMatches) {
        fail("Catalog edge query profile does not match its target page");
      }
    }
  }

  if (!Array.isArray(value.unresolved_references)) {
    fail("Catalog unresolved_references must be an array");
  }
  assertCanonicalOrder(
    value.unresolved_references,
    "Catalog unresolved references",
  );
  assertUnique(
    value.unresolved_references.map(stableStringify),
    "Catalog unresolved references",
  );
  for (const reference of value.unresolved_references) {
    assertObject(reference, "Catalog unresolved reference");
    assertExactKeys(
      reference,
      ["from_page_id", "relation", "target", "reason"],
      "Catalog unresolved reference",
    );
    if (!pageIds.has(reference.from_page_id)) {
      fail("Catalog unresolved reference originates outside the closure");
    }
    assertCanonicalString(reference.relation, "Catalog reference relation");
    validateReferenceTarget(reference.target, false);
    if (!REFERENCE_REASONS.has(reference.reason)) {
      fail("Catalog unresolved reference reason is unsupported");
    }
  }
  const expectedComplete =
    value.roots.every((root) => root.status === "resolved") &&
    value.unresolved_references.length === 0;
  if (value.closure_complete !== expectedComplete) {
    fail("Catalog closure_complete is inconsistent");
  }
}

function validateReferenceTarget(target, requireDocumentType) {
  assertObject(target, "Catalog reference target");
  const allowed = ["document_type", "entity_id", "query_profile_id"];
  assertAllowedKeys(target, allowed, "Catalog reference target");
  if (requireDocumentType || target.document_type !== undefined) {
    assertCanonicalString(target.document_type, "reference document_type");
  }
  if (target.entity_id !== undefined) {
    assertCanonicalString(target.entity_id, "reference entity_id");
  }
  if (target.query_profile_id !== undefined) {
    assertCanonicalString(
      target.query_profile_id,
      "reference query_profile_id",
    );
  }
  if (
    target.document_type === undefined &&
    target.entity_id === undefined &&
    target.query_profile_id === undefined
  ) {
    fail("Catalog reference target is empty");
  }
}

function validateFullPage(page) {
  assertObject(page, "Catalog page");
  assertExactKeys(
    page,
    [
      "page_id",
      "title",
      "parent_page_id",
      "space_id",
      "updated_at",
      "content_sha256",
      "front_matter",
      "markdown",
    ],
    "Catalog page",
  );
  assertUuid(page.page_id, "Catalog page_id");
  if (page.title !== null && typeof page.title !== "string") {
    fail("Catalog page title is invalid");
  }
  if (page.parent_page_id !== null) {
    assertUuid(page.parent_page_id, "Catalog parent_page_id");
  }
  assertUuid(page.space_id, "Catalog space_id");
  assertIsoTimestamp(page.updated_at, "Catalog updated_at");
  if (!SHA256_PATTERN.test(page.content_sha256)) {
    fail("Catalog page content_sha256 is invalid");
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
  if (typeof page.markdown !== "string") {
    fail("Catalog page markdown must be a string");
  }
  if (Buffer.byteLength(page.markdown, "utf8") > MAX_PAGE_MARKDOWN_BYTES) {
    fail("Catalog page markdown exceeds the plugin limit");
  }
  if (sha256(page.markdown) !== page.content_sha256) {
    fail(`Catalog page ${page.page_id} content hash does not match Markdown`);
  }
  return page;
}

function validateManifestItem(page, location) {
  assertObject(page, `Catalog ${location} item`);
  assertExactKeys(
    page,
    ["page_id", "updated_at", "content_sha256"],
    `Catalog ${location} item`,
  );
  assertUuid(page.page_id, `${location}.page_id`);
  assertIsoTimestamp(page.updated_at, `${location}.updated_at`);
  if (!SHA256_PATTERN.test(page.content_sha256)) {
    fail(`${location}.content_sha256 is invalid`);
  }
  return page;
}

function validateFreshnessProof(args, proof, manifest, fingerprint) {
  assertObject(proof, "Catalog freshness_proof");
  assertExactKeys(
    proof,
    [
      "schema_version",
      "challenge",
      "verified_at",
      "isolation",
      "read_only",
      "page_manifest",
      "bundle_fingerprint",
    ],
    "Catalog freshness_proof",
  );
  if (proof.schema_version !== CATALOG_FRESHNESS_SCHEMA_VERSION) {
    fail("Catalog freshness proof schema_version is unsupported");
  }
  if (proof.challenge !== args.challenge) {
    fail("Catalog freshness proof challenge does not match the request");
  }
  assertIsoTimestamp(proof.verified_at, "freshness_proof.verified_at");
  if (proof.isolation !== "repeatable_read" || proof.read_only !== true) {
    fail("Catalog freshness proof does not attest a read-only repeatable read");
  }
  if (proof.bundle_fingerprint !== fingerprint) {
    fail("Catalog freshness proof fingerprint is inconsistent");
  }
  if (stableStringify(proof.page_manifest) !== stableStringify(manifest)) {
    fail("Catalog freshness proof manifest is inconsistent");
  }
}

function validateDeltaChanges(previousPages, currentManifest, changes) {
  assertObject(changes, "Catalog delta changes");
  assertExactKeys(
    changes,
    ["added", "updated", "removed", "unchanged"],
    "Catalog delta changes",
  );
  for (const field of ["added", "updated", "removed", "unchanged"]) {
    if (!Array.isArray(changes[field])) {
      fail(`Catalog delta changes.${field} must be an array`);
    }
  }
  const previous = new Map(
    previousPages.map((page) => [
      page.pageId,
      {
        page_id: page.pageId,
        updated_at: page.updatedAt,
        content_sha256: page.contentSha256,
      },
    ]),
  );
  const current = new Map(currentManifest.map((page) => [page.page_id, page]));
  const classified = new Set();

  for (const pageValue of changes.added) {
    const page = validateFullPage(pageValue);
    classifyOnce(classified, page.page_id);
    if (
      previous.has(page.page_id) ||
      !manifestEquals(current.get(page.page_id), page)
    ) {
      fail("Catalog delta added pages are inconsistent");
    }
  }
  for (const update of changes.updated) {
    assertObject(update, "Catalog delta updated item");
    assertExactKeys(
      update,
      ["previous", "current"],
      "Catalog delta updated item",
    );
    const prior = validateManifestItem(update.previous, "updated.previous");
    const page = validateFullPage(update.current);
    classifyOnce(classified, page.page_id);
    if (
      prior.page_id !== page.page_id ||
      !manifestEquals(previous.get(page.page_id), prior) ||
      !manifestEquals(current.get(page.page_id), page) ||
      manifestEquals(prior, page)
    ) {
      fail("Catalog delta updated pages are inconsistent");
    }
  }
  for (const pageValue of changes.removed) {
    const page = validateManifestItem(pageValue, "removed");
    classifyOnce(classified, page.page_id);
    if (
      !manifestEquals(previous.get(page.page_id), page) ||
      current.has(page.page_id)
    ) {
      fail("Catalog delta removed pages are inconsistent");
    }
  }
  for (const pageValue of changes.unchanged) {
    const page = validateManifestItem(pageValue, "unchanged");
    classifyOnce(classified, page.page_id);
    if (
      !manifestEquals(previous.get(page.page_id), page) ||
      !manifestEquals(current.get(page.page_id), page)
    ) {
      fail("Catalog delta unchanged pages are inconsistent");
    }
  }
  const expectedIds = new Set([...previous.keys(), ...current.keys()]);
  if (
    classified.size !== expectedIds.size ||
    [...expectedIds].some((pageId) => !classified.has(pageId))
  ) {
    fail("Catalog delta changes do not form a complete page partition");
  }
  assertPageIdOrder(
    changes.added,
    (page) => page.page_id,
    "Catalog delta added pages",
  );
  assertPageIdOrder(
    changes.updated,
    (update) => update.current.page_id,
    "Catalog delta updated pages",
  );
  assertPageIdOrder(
    changes.removed,
    (page) => page.page_id,
    "Catalog delta removed pages",
  );
  assertPageIdOrder(
    changes.unchanged,
    (page) => page.page_id,
    "Catalog delta unchanged pages",
  );
}

function validateSummaryContent(result) {
  if (!Array.isArray(result.content)) {
    fail("Catalog tool result content must be an array");
  }
  let totalBytes = 0;
  for (const item of result.content) {
    if (
      !isObject(item) ||
      item.type !== "text" ||
      typeof item.text !== "string"
    ) {
      fail("Catalog tool result content must contain text summaries only");
    }
    totalBytes += Buffer.byteLength(item.text, "utf8");
  }
  if (totalBytes > 16 * 1024) {
    fail("Catalog text summary is unexpectedly large");
  }
}

function validatePrevious(previous) {
  assertObject(previous, "previous");
  assertExactKeys(previous, ["bundleFingerprint", "pages"], "previous");
  if (!SHA256_PATTERN.test(previous.bundleFingerprint)) {
    fail("previous.bundleFingerprint is invalid");
  }
  if (!Array.isArray(previous.pages) || previous.pages.length > MAX_PAGES) {
    fail(`previous.pages must contain at most ${MAX_PAGES} items`);
  }
  const ids = [];
  for (const page of previous.pages) {
    assertObject(page, "previous.pages item");
    assertExactKeys(
      page,
      ["pageId", "updatedAt", "contentSha256"],
      "previous.pages item",
    );
    assertUuid(page.pageId, "previous.pages.pageId");
    assertIsoTimestamp(page.updatedAt, "previous.pages.updatedAt");
    if (!SHA256_PATTERN.test(page.contentSha256)) {
      fail("previous.pages.contentSha256 is invalid");
    }
    ids.push(page.pageId);
  }
  assertUnique(ids, "previous.pages pageId values");
}

function validateRootSelector(selector) {
  assertObject(selector, "Catalog root selector");
  const keys = Object.keys(selector).sort();
  if (keys.length === 1 && keys[0] === "pageId") {
    assertUuid(selector.pageId, "roots.pageId");
    return;
  }
  if (
    keys.length === 2 &&
    keys[0] === "documentType" &&
    keys[1] === "entityId"
  ) {
    assertCanonicalString(selector.documentType, "roots.documentType");
    assertCanonicalString(selector.entityId, "roots.entityId");
    return;
  }
  fail("Each Catalog root must contain pageId or documentType and entityId");
}

function validateOutputRootSelector(selector) {
  const keys = Object.keys(selector).sort();
  if (keys.length === 1 && keys[0] === "page_id") {
    assertUuid(selector.page_id, "root selector page_id");
    return { page_id: selector.page_id };
  }
  if (
    keys.length === 2 &&
    keys[0] === "document_type" &&
    keys[1] === "entity_id"
  ) {
    assertCanonicalString(
      selector.document_type,
      "root selector document_type",
    );
    assertCanonicalString(selector.entity_id, "root selector entity_id");
    return {
      document_type: selector.document_type,
      entity_id: selector.entity_id,
    };
  }
  fail("Catalog response contains an invalid root selector");
}

function inputSelectorToOutput(selector) {
  return "pageId" in selector
    ? { page_id: selector.pageId }
    : {
        document_type: selector.documentType,
        entity_id: selector.entityId,
      };
}

function pageManifest(pages) {
  return pages
    .map((page) => ({
      page_id: page.page_id,
      updated_at: page.updated_at,
      content_sha256: page.content_sha256,
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.page_id, right.page_id),
    );
}

function computeBundleFingerprint(input) {
  return sha256(
    stableStringify({
      contract: QTS_FACT_CATALOG_CONTRACT,
      catalog_root_page_id: input.catalogRootPageId,
      environment: input.environment,
      roots: sortCanonical(input.roots),
      pages: sortCanonical(input.pages),
      edges: sortCanonical(input.edges),
      unresolved_references: sortCanonical(input.unresolvedReferences),
    }),
  );
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sortCanonical(items) {
  return [...items].sort((left, right) => {
    const leftValue = stableStringify(left);
    const rightValue = stableStringify(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
}

function compareCanonicalStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueCanonical(items) {
  return sortCanonical([
    ...new Map(items.map((item) => [stableStringify(item), item])).values(),
  ]);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function manifestEquals(left, right) {
  return Boolean(
    left &&
    right &&
    left.page_id === right.page_id &&
    left.updated_at === right.updated_at &&
    left.content_sha256 === right.content_sha256,
  );
}

function classifyOnce(classified, pageId) {
  if (classified.has(pageId)) {
    fail(`Catalog delta page ${pageId} is classified more than once`);
  }
  classified.add(pageId);
}

function assertCanonicalOrder(items, name) {
  if (stableStringify(items) !== stableStringify(sortCanonical(items))) {
    fail(`${name} are not in canonical order`);
  }
}

function assertPageIdOrder(items, getPageId, name) {
  const pageIds = items.map(getPageId);
  if (pageIds.some((pageId) => typeof pageId !== "string")) {
    fail(`${name} contain an invalid page ID`);
  }
  const sortedPageIds = [...pageIds].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (stableStringify(pageIds) !== stableStringify(sortedPageIds)) {
    fail(`${name} are not ordered by page_id`);
  }
}

function assertUnique(values, name) {
  if (new Set(values).size !== values.length) {
    fail(`${name} contain duplicates`);
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

function assertObject(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
}

function assertExactKeys(value, expected, name) {
  assertObject(value, name);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (stableStringify(actualKeys) !== stableStringify(expectedKeys)) {
    fail(`${name} contains missing or unexpected fields`);
  }
}

function assertAllowedKeys(value, allowed, name) {
  assertObject(value, name);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`${name} contains unexpected fields`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new CatalogValidationError(message);
}

module.exports = {
  CATALOG_BUNDLE_SCHEMA_VERSION,
  CATALOG_DELTA_SCHEMA_VERSION,
  CATALOG_FRESHNESS_SCHEMA_VERSION,
  CATALOG_TOOLS,
  CatalogValidationError,
  MAX_EDGES,
  MAX_PAGES,
  MAX_ROOTS,
  QTS_FACT_CATALOG_CONTRACT,
  computeBundleFingerprint,
  pageManifest,
  sha256,
  stableStringify,
  validateBundle,
  validateCatalogToolInput,
  validateCatalogToolResult,
  validateDelta,
};
