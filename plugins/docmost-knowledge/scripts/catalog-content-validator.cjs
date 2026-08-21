"use strict";

const { createHash } = require("node:crypto");
const { isAlias, parseDocument, visit } = require("../vendor/yaml.cjs");

const YAML_FENCE_PATTERN = /^ {0,3}```yaml[ \t]*$/i;
const FENCE_CLOSE_PATTERN = /^ {0,3}```[ \t]*$/;
const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,511}$/;
const SUPPORTED_SCHEMAS = new Map([
  ["service_profile", new Set(["service-profile.v2"])],
  ["infrastructure_profile", new Set(["infrastructure-profile.v2"])],
  ["gateway_route", new Set(["gateway-route.v1"])],
  ["fact_source_profile", new Set(["fact-source-profile.v2"])],
  ["query_profile_set", new Set(["query-profile-set.v1"])],
  ["known_root_cause", new Set(["known-root-cause.v1"])],
]);

function validateCatalogContent(input, fail) {
  const pages = input.pages;
  const parsedPages = pages.map((page) => {
    const parsed = parseFirstFencedYaml(page.markdown, fail);
    if (stableStringify(parsed) !== stableStringify(page.front_matter)) {
      fail("Catalog Markdown YAML does not equal response front_matter");
    }
    if (!isSupportedFrontMatter(parsed)) {
      fail("Catalog Markdown contains an unsupported document schema");
    }
    const frontMatterSha256 = sha256(stableStringify(parsed));
    if (
      input.requireFrontMatterHash &&
      page.front_matter_sha256 !== frontMatterSha256
    ) {
      fail("Catalog front_matter_sha256 does not match parsed YAML");
    }
    return {
      ...page,
      parsed_front_matter: parsed,
      derived_front_matter_sha256: frontMatterSha256,
      identity: {
        documentType: parsed.document_type,
        entityId: parsed.entity_id,
      },
    };
  });
  const indexes = buildIndexes(parsedPages, fail);
  const roots = validateAndDeriveRoots(input.requestedRoots, input.roots, indexes, fail);
  const resolvedRootEntities = new Map(
    roots
      .filter((root) => root.status === "resolved")
      .map((root) => [root.entity_id, root]),
  );
  const candidates = deriveCandidates(
    parsedPages,
    resolvedRootEntities,
    input.environment,
  );
  if (stableStringify(candidates) !== stableStringify(input.candidates)) {
    fail("Catalog KRC candidates do not match current page content");
  }

  const actualEdges = uniqueMap(input.edges, "Catalog edges", fail);
  const actualUnresolved = uniqueMap(
    input.unresolvedReferences,
    "Catalog unresolved references",
    fail,
  );
  const usedEdges = new Set();
  const usedUnresolved = new Set();
  const reachable = new Set(
    roots
      .filter((root) => root.status === "resolved")
      .map((root) => root.page_id),
  );
  const queue = [...reachable];

  while (queue.length > 0) {
    const pageId = queue.shift();
    const page = indexes.byPageId.get(pageId);
    if (!page) fail("Catalog reachable page is absent from the response");
    for (const reference of extractReferences(
      page.parsed_front_matter,
      input.environment,
    )) {
      const resolved = resolveReference(reference, indexes);
      if (reference.invalid || resolved.length !== 1) {
        consumeUnresolved(
          page.page_id,
          reference,
          resolved.length,
          actualUnresolved,
          usedUnresolved,
          fail,
        );
        continue;
      }
      const target = resolved[0];
      consumeEdge(
        page.page_id,
        target,
        reference,
        actualEdges,
        usedEdges,
        fail,
      );
      if (!reachable.has(target.page_id)) {
        reachable.add(target.page_id);
        queue.push(target.page_id);
      }
    }
  }

  for (const candidate of candidates) {
    reachable.add(candidate.page_id);
    for (const affectedEntity of candidate.affected_entities) {
      const root = resolvedRootEntities.get(affectedEntity);
      if (!root) continue;
      consumeEdge(
        candidate.page_id,
        indexes.byPageId.get(root.page_id),
        {
          relation: "known_root_cause.affected_entities",
          targetDocumentType: root.document_type,
          targetEntityId: affectedEntity,
        },
        actualEdges,
        usedEdges,
        fail,
      );
    }
  }

  validateReverseReferences({
    indexes,
    actualEdges,
    actualUnresolved,
    usedEdges,
    usedUnresolved,
    legacyReverseRelation: input.legacyReverseRelation === true,
    fail,
  });

  if (usedEdges.size !== actualEdges.size) {
    fail("Catalog response contains an extra or unextracted edge");
  }
  if (usedUnresolved.size !== actualUnresolved.size) {
    fail("Catalog response contains an extra or unextracted unresolved reference");
  }
  if (
    reachable.size !== parsedPages.length ||
    parsedPages.some((page) => !reachable.has(page.page_id))
  ) {
    fail("Catalog response contains pages outside the requested closure");
  }

  const derived = {
    roots_resolved: roots.every((root) => root.status === "resolved"),
    reference_fields_scanned: parsedPages.every((page) =>
      isSupportedFrontMatter(page.parsed_front_matter),
    ),
    required_targets_resolved: input.unresolvedReferences.length === 0,
    unresolved_references_empty: input.unresolvedReferences.length === 0,
    known_root_cause_discovery_complete:
      input.closureStatus.known_root_cause_discovery_complete,
  };
  for (const field of [
    "roots_resolved",
    "reference_fields_scanned",
    "required_targets_resolved",
    "unresolved_references_empty",
  ]) {
    if (input.closureStatus[field] !== derived[field]) {
      fail(`Catalog closure ${field} was not locally derived`);
    }
  }
  if (input.closureComplete !== Object.values(derived).every(Boolean)) {
    fail("Catalog closure_complete was not locally derived");
  }
  return { pages: parsedPages, roots, candidates, closureStatus: derived };
}

function parseFirstFencedYaml(markdown, fail = defaultFail) {
  if (typeof markdown !== "string") fail("Catalog Markdown must be a string");
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const openingIndex = lines.findIndex((line) => YAML_FENCE_PATTERN.test(line));
  if (openingIndex < 0) fail("Catalog Markdown has no fenced YAML block");
  const closingOffset = lines
    .slice(openingIndex + 1)
    .findIndex((line) => FENCE_CLOSE_PATTERN.test(line));
  if (closingOffset < 0) fail("Catalog fenced YAML block is not closed");
  const source = lines
    .slice(openingIndex + 1, openingIndex + closingOffset + 1)
    .join("\n");
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
    customTags: [],
  });
  let containsAlias = false;
  visit(document, (_key, node) => {
    if (isAlias(node)) {
      containsAlias = true;
      return visit.BREAK;
    }
    return undefined;
  });
  if (
    containsAlias ||
    document.errors.length > 0 ||
    document.warnings.length > 0
  ) {
    fail("Catalog fenced YAML block is invalid");
  }
  let value;
  try {
    value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch {
    fail("Catalog fenced YAML block is invalid");
  }
  if (!isObject(value)) fail("Catalog fenced YAML block must be an object");
  assertJsonValue(value, fail);
  return value;
}

function buildIndexes(pages, fail) {
  const byPageId = new Map();
  const byIdentity = new Map();
  const queryProfileOwners = new Map();
  for (const page of pages) {
    if (byPageId.has(page.page_id)) fail("Catalog page IDs contain duplicates");
    byPageId.set(page.page_id, page);
    const identityKey = keyOf({
      document_type: page.identity.documentType,
      entity_id: page.identity.entityId,
    });
    const identityPages = byIdentity.get(identityKey) ?? [];
    identityPages.push(page);
    byIdentity.set(identityKey, identityPages);
    if (page.identity.documentType !== "query_profile_set") continue;
    const profiles = page.parsed_front_matter.query_profiles;
    if (!Array.isArray(profiles)) continue;
    for (const profile of profiles) {
      if (!isObject(profile)) continue;
      const profileId = canonicalString(profile.query_profile_id);
      if (!profileId) continue;
      const owners = queryProfileOwners.get(profileId) ?? [];
      owners.push(page);
      queryProfileOwners.set(profileId, owners);
    }
  }
  return { byPageId, byIdentity, queryProfileOwners };
}

function validateAndDeriveRoots(requested, actual, indexes, fail) {
  const canonicalRequested = canonicalRequestedRoots(requested);
  if (canonicalRequested.length !== actual.length) {
    fail("Catalog roots do not cover the requested selectors");
  }
  const actualBySelector = new Map();
  for (const root of actual) {
    const key = stableStringify(root.selector);
    if (actualBySelector.has(key)) fail("Catalog roots contain duplicates");
    actualBySelector.set(key, root);
  }
  const derived = [];
  for (const selector of canonicalRequested) {
    const root = actualBySelector.get(stableStringify(selector));
    if (!root) fail("Catalog root selector is missing from the response");
    const matches =
      "page_id" in selector
        ? indexes.byPageId.has(selector.page_id)
          ? [indexes.byPageId.get(selector.page_id)]
          : []
        : indexes.byIdentity.get(keyOf(selector)) ?? [];
    if (matches.length === 1) {
      const page = matches[0];
      if (
        root.status !== "resolved" ||
        root.page_id !== page.page_id ||
        root.document_type !== page.identity.documentType ||
        root.entity_id !== page.identity.entityId
      ) {
        fail("Catalog resolved root does not match parsed page identity");
      }
    } else if (root.status !== "unresolved") {
      fail("Catalog unresolved root was incorrectly reported as resolved");
    }
    derived.push(root);
  }
  return derived.sort(compareCanonical);
}

function deriveCandidates(pages, rootsByEntity, environment) {
  const candidates = [];
  for (const page of pages) {
    const matter = page.parsed_front_matter;
    if (
      matter.document_type !== "known_root_cause" ||
      matter.schema_version !== "known-root-cause.v1" ||
      matter.status !== "active" ||
      !isObject(matter.verification) ||
      matter.verification.status !== "confirmed"
    ) {
      continue;
    }
    const affected = canonicalStringArray(matter.affected_entities, "entity_id");
    const environments = canonicalStringArray(matter.environment_scope);
    if (!affected || !environments) continue;
    if (
      !environments.includes(environment) &&
      !environments.includes("*") &&
      !environments.includes("all")
    ) {
      continue;
    }
    const matched = affected.filter((entity) => rootsByEntity.has(entity));
    if (matched.length === 0) continue;
    candidates.push({
      page_id: page.page_id,
      document_type: "known_root_cause",
      entity_id: matter.entity_id,
      affected_entities: affected,
      environment_scope: environments,
      selection_reason: `active confirmed candidate for ${matched.join(", ")} in ${environment}`,
    });
  }
  return candidates.sort(compareCanonical);
}

function extractReferences(frontMatter, environment) {
  const references = [];
  pushIdentityArray(
    references,
    frontMatter.fact_sources,
    "fact_sources",
    "fact_source_profile",
  );
  const documentType = frontMatter.document_type;
  if (documentType === "service_profile" && isObject(frontMatter.environments)) {
    const environmentConfig = frontMatter.environments[environment];
    if (isObject(environmentConfig)) {
      pushIdentityArray(
        references,
        environmentConfig.gateway_routes,
        `environments.${environment}.gateway_routes`,
        "gateway_route",
      );
    }
  }
  if (["service_profile", "infrastructure_profile"].includes(documentType)) {
    pushQueryProfiles(references, frontMatter.query_profile_refs, "query_profile_refs");
  }
  if (documentType === "fact_source_profile") {
    pushDefaultQueryProfiles(references, frontMatter.default_query_profile_refs);
  }
  if (documentType === "query_profile_set") {
    if (frontMatter.fact_source === undefined) {
      references.push({
        relation: "query_profile_set.fact_source",
        targetDocumentType: "fact_source_profile",
        invalid: true,
      });
    } else {
      pushSingleIdentity(
        references,
        frontMatter.fact_source,
        "query_profile_set.fact_source",
        "fact_source_profile",
      );
    }
  }
  if (["gateway_route", "infrastructure_profile"].includes(documentType)) {
    const observability = frontMatter.gateway_observability;
    if (isObject(observability)) {
      if (documentType === "gateway_route") {
        pushSingleIdentity(
          references,
          observability.gateway_profile,
          "gateway_observability.gateway_profile",
          "infrastructure_profile",
        );
      }
      collectGatewayProfiles(references, observability, "gateway_observability");
    }
  }
  return references;
}

function validateReverseReferences(state) {
  for (const edge of state.actualEdges.values()) {
    if (
      !edge.relation.startsWith("environments.") ||
      !edge.relation.endsWith(".gateway_routes")
    ) {
      continue;
    }
    const service = state.indexes.byPageId.get(edge.from_page_id);
    const route = state.indexes.byPageId.get(edge.to_page_id);
    if (!service || !route) continue;
    const backends = canonicalStringArray(
      route.parsed_front_matter.backend_services,
    );
    const reference = {
      relation: "gateway_route.backend_services",
      targetDocumentType: "service_profile",
      targetEntityId: service.identity.entityId,
    };
    if (backends?.includes(service.identity.entityId)) {
      consumeEdge(
        route.page_id,
        service,
        reference,
        state.actualEdges,
        state.usedEdges,
        state.fail,
      );
    } else {
      consumeUnresolved(
        route.page_id,
        { ...reference, reverse: true },
        0,
        state.actualUnresolved,
        state.usedUnresolved,
        state.fail,
      );
    }
  }

  for (const page of state.indexes.byPageId.values()) {
    if (page.identity.documentType !== "query_profile_set") continue;
    const sourceId = canonicalString(page.parsed_front_matter.fact_source);
    if (!sourceId) continue;
    const sources =
      state.indexes.byIdentity.get(
        keyOf({
          document_type: "fact_source_profile",
          entity_id: sourceId,
        }),
      ) ?? [];
    if (sources.length !== 1) continue;
    const source = sources[0];
    const refs = source.parsed_front_matter.query_profile_set_refs;
    const matching = Array.isArray(refs)
      ? refs.find(
          (item) => isObject(item) && item.entity_id === page.identity.entityId,
        )
      : undefined;
    if (!isObject(matching)) {
      consumeUnresolved(
        page.page_id,
        {
          relation: state.legacyReverseRelation
            ? "query_profile_set.fact_source"
            : "query_profile_set.fact_source.reverse_validation",
          targetDocumentType: "fact_source_profile",
          targetEntityId: sourceId,
          reverse: true,
        },
        0,
        state.actualUnresolved,
        state.usedUnresolved,
        state.fail,
      );
      continue;
    }
    const indexed = canonicalStringArray(matching.query_profile_ids);
    const profileIds = Array.isArray(page.parsed_front_matter.query_profiles)
      ? page.parsed_front_matter.query_profiles
          .filter(isObject)
          .map((item) => canonicalString(item.query_profile_id))
          .filter(Boolean)
      : null;
    if (
      !indexed ||
      !profileIds ||
      stableStringify([...indexed].sort()) !==
        stableStringify([...profileIds].sort())
    ) {
      consumeUnresolved(
        source.page_id,
        {
          relation: "query_profile_set_refs.query_profile_ids",
          targetDocumentType: "query_profile_set",
          targetEntityId: page.identity.entityId,
          reverse: true,
        },
        0,
        state.actualUnresolved,
        state.usedUnresolved,
        state.fail,
      );
    }
  }
}

function consumeEdge(fromPageId, targetPage, reference, actual, used, fail) {
  if (!targetPage) fail("Catalog edge target page is absent");
  const expected = {
    from_page_id: fromPageId,
    to_page_id: targetPage.page_id,
    relation: reference.relation,
    target: referenceTarget(reference),
  };
  const key = stableStringify(expected);
  const edge = actual.get(key);
  if (!edge || used.has(key)) {
    fail("Catalog extracted reference is missing its exact edge");
  }
  if (
    edge.target.document_type !== targetPage.identity.documentType ||
    (edge.target.entity_id !== undefined &&
      edge.target.entity_id !== targetPage.identity.entityId) ||
    (edge.target.query_profile_id !== undefined &&
      !pageOwnsQueryProfile(targetPage, edge.target.query_profile_id))
  ) {
    fail("Catalog edge target does not match the target page identity");
  }
  used.add(key);
}

function consumeUnresolved(
  fromPageId,
  reference,
  resolutionCount,
  actual,
  used,
  fail,
) {
  const prefix = {
    from_page_id: fromPageId,
    relation: reference.relation,
    target: referenceTarget(reference),
  };
  const matches = [...actual.entries()].filter(([, value]) =>
    ["from_page_id", "relation", "target"].every(
      (field) => stableStringify(value[field]) === stableStringify(prefix[field]),
    ),
  );
  if (matches.length !== 1 || used.has(matches[0]?.[0])) {
    fail("Catalog extracted reference is missing one exact unresolved result");
  }
  const [key, unresolved] = matches[0];
  const allowedReasons = reference.reverse
    ? new Set(["reverse_validation_failed"])
    : reference.invalid
      ? new Set(["invalid_reference"])
      : resolutionCount > 1
        ? new Set(["ambiguous_identity"])
        : new Set([
            "missing_or_not_accessible",
            "malformed_catalog_page",
            "unsupported_catalog_document",
          ]);
  if (!allowedReasons.has(unresolved.reason)) {
    fail("Catalog unresolved reason contradicts local reference resolution");
  }
  used.add(key);
}

function resolveReference(reference, indexes) {
  if (reference.invalid) return [];
  if (reference.queryProfileId) {
    return indexes.queryProfileOwners.get(reference.queryProfileId) ?? [];
  }
  if (reference.targetDocumentType && reference.targetEntityId) {
    return (
      indexes.byIdentity.get(
        keyOf({
          document_type: reference.targetDocumentType,
          entity_id: reference.targetEntityId,
        }),
      ) ?? []
    );
  }
  return [];
}

function referenceTarget(reference) {
  return {
    document_type: reference.targetDocumentType,
    ...(reference.targetEntityId
      ? { entity_id: reference.targetEntityId }
      : {}),
    ...(reference.queryProfileId
      ? { query_profile_id: reference.queryProfileId }
      : {}),
  };
}

function pushIdentityArray(references, value, relation, targetDocumentType) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    references.push({ relation, targetDocumentType, invalid: true });
    return;
  }
  for (const item of value) {
    const entityId =
      canonicalString(item) ??
      (isObject(item) ? canonicalString(item.entity_id) : undefined);
    references.push({
      relation,
      targetDocumentType,
      targetEntityId: entityId,
      invalid: !entityId,
    });
  }
}

function pushSingleIdentity(references, value, relation, targetDocumentType) {
  if (value === undefined) return;
  const entityId =
    canonicalString(value) ??
    (isObject(value) ? canonicalString(value.entity_id) : undefined);
  references.push({
    relation,
    targetDocumentType,
    targetEntityId: entityId,
    invalid: !entityId,
  });
}

function pushQueryProfiles(references, value, relation) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    references.push({
      relation,
      targetDocumentType: "query_profile_set",
      invalid: true,
    });
    return;
  }
  for (const item of value) {
    const profileId = isObject(item)
      ? canonicalString(item.query_profile_id)
      : canonicalString(item);
    references.push({
      relation,
      targetDocumentType: "query_profile_set",
      queryProfileId: profileId,
      invalid: !profileId,
    });
  }
}

function pushDefaultQueryProfiles(references, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    references.push({
      relation: "default_query_profile_refs",
      targetDocumentType: "query_profile_set",
      invalid: true,
    });
    return;
  }
  for (const [ownerType, profileIds] of Object.entries(value)) {
    if (!Array.isArray(profileIds)) {
      references.push({
        relation: `default_query_profile_refs.${ownerType}`,
        targetDocumentType: "query_profile_set",
        invalid: true,
      });
      continue;
    }
    for (const value of profileIds) {
      const profileId = canonicalString(value);
      references.push({
        relation: `default_query_profile_refs.${ownerType}`,
        targetDocumentType: "query_profile_set",
        queryProfileId: profileId,
        invalid: !profileId,
      });
    }
  }
}

function collectGatewayProfiles(references, value, path) {
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === "query_profile_id") {
      const profileId = canonicalString(child);
      references.push({
        relation: childPath,
        targetDocumentType: "query_profile_set",
        queryProfileId: profileId,
        invalid: !profileId,
      });
    } else if (isObject(child)) {
      collectGatewayProfiles(references, child, childPath);
    } else if (Array.isArray(child)) {
      child.forEach((item, index) => {
        if (isObject(item)) {
          collectGatewayProfiles(references, item, `${childPath}[${index}]`);
        }
      });
    }
  }
}

function canonicalRequestedRoots(roots) {
  const values = new Map();
  for (const root of roots) {
    const output =
      "pageId" in root
        ? { page_id: root.pageId }
        : { document_type: root.documentType, entity_id: root.entityId };
    values.set(stableStringify(output), output);
  }
  return [...values.values()].sort(compareCanonical);
}

function canonicalStringArray(value, objectField) {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) return null;
  const strings = values.map((item) =>
    canonicalString(item) ??
    (objectField && isObject(item) ? canonicalString(item[objectField]) : undefined),
  );
  if (strings.some((item) => !item)) return null;
  return [...new Set(strings)].sort(compare);
}

function pageOwnsQueryProfile(page, profileId) {
  const profiles = page.parsed_front_matter.query_profiles;
  return (
    Array.isArray(profiles) &&
    profiles.some(
      (profile) =>
        isObject(profile) && profile.query_profile_id === profileId,
    )
  );
}

function isSupportedFrontMatter(value) {
  return Boolean(
    isObject(value) &&
      canonicalString(value.document_type) &&
      canonicalString(value.schema_version) &&
      canonicalString(value.entity_id) &&
      ENTITY_ID_PATTERN.test(value.entity_id) &&
      SUPPORTED_SCHEMAS.get(value.document_type)?.has(value.schema_version),
  );
}

function uniqueMap(values, name, fail) {
  const result = new Map();
  for (const value of values) {
    const key = stableStringify(value);
    if (result.has(key)) fail(`${name} contain duplicates`);
    result.set(key, value);
  }
  return result;
}

function keyOf(identity) {
  return `${identity.document_type}\0${identity.entity_id}`;
}

function canonicalString(value) {
  return typeof value === "string" && value && value.trim() === value
    ? value
    : undefined;
}

function assertJsonValue(value, fail, depth = 0) {
  if (depth > 100) fail("Catalog YAML is too deeply nested");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertJsonValue(item, fail, depth + 1));
    return;
  }
  if (isObject(value)) {
    Object.values(value).forEach((item) =>
      assertJsonValue(item, fail, depth + 1),
    );
    return;
  }
  fail("Catalog YAML contains a non-JSON value");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCanonical(left, right) {
  return compare(stableStringify(left), stableStringify(right));
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultFail(message) {
  throw new Error(message);
}

module.exports = {
  canonicalRequestedRoots,
  parseFirstFencedYaml,
  sha256,
  stableStringify,
  validateCatalogContent,
};
