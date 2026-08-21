# Changelog

## 0.7.0 - 2026-08-21

- Added `begin_catalog_resolution`, `resolve_catalog_bundle_v3`, and
  `resolve_catalog_delta_v3` contract validation without changing published v2
  schemas.
- Added pinned, signed, expiring one-use start tickets and strict proof binding
  for challenge, authorization context, complete current roots, one snapshot,
  page manifest, extractor version, and Bundle fingerprint.
- Added strict fenced-YAML parsing with canonical deep equality against response
  front matter and `front_matter_sha256` binding in manifests and fingerprints.
- Re-extract and reconcile every reference locally, reject missing, extra,
  duplicate, or identity-inconsistent edges, and re-derive roots, KRC candidates,
  closure status, and completeness.
- Added roots-expanding Delta v3 with exact `root_changes` and complete,
  mutually exclusive page partitions while preserving v2 same-roots behavior.
- Require `catalogPublicKeys` for all signed v2/v3 calls and report `pinCount`
  plus non-sensitive key IDs in doctor; ordinary Docmost tools remain usable
  without pins.
- Added configurable signed-resolution time limits, snapshot-window checks,
  current/next Ed25519 rotation, synthetic/tamper/partial-closure/KRC/hash/roots
  fixtures, and an isolated installed-directory full-suite test.
- Bundled the YAML parser and license so installed plugin caches do not depend
  on repository parents or external `node_modules` layout.

## 0.6.0 - 2026-08-21

- Added separately negotiated `resolve_catalog_bundle_v2` and
  `resolve_catalog_delta_v2` tools while keeping the published v1 pair
  immutable.
- Added strict `catalog-bundle.v2`, `catalog-delta.v2`, and signed
  `catalog-freshness-proof.v2` validation for fenced-YAML Catalog closures.
- Verify canonical ordering, Markdown hashes, resolved-root KRC applicability,
  full fingerprints, Ed25519 signatures, and complete Delta partitions before
  returning remote results.
- Added optional profile-level Catalog public-key pinning through
  `catalogPublicKeys` or `DOCMOST_CATALOG_PUBLIC_KEYS`, including rotation with
  multiple trusted key IDs.
- Added v2 capability reporting to the doctor and live smoke test, bundled JSON
  Schemas, tamper fixtures, and signed Bundle/Delta regression coverage.
- Disabled transparent retry for challenge-consuming v2 calls; ambiguous
  transport failures now require a fresh caller-generated challenge.

## 0.5.0 - 2026-08-20

- Added optional capability negotiation for `resolve_catalog_bundle` and
  `resolve_catalog_delta` while preserving compatibility with v0.4 servers
  that expose neither tool.
- Added strict `catalog-bundle.v1`, `catalog-delta.v1`, and
  `catalog-freshness-proof.v1` validation, including challenge echo, page
  hashes, deterministic fingerprints, complete graph closure, and complete
  Delta partitions.
- Added bounded streaming response reads with a 16 MiB default and 32 MiB
  hard maximum.
- Classified both Catalog operations as retry-safe reads and reject malformed
  inputs or tampered remote results at the local proxy boundary.
- Documented per-diagnosis live revalidation, tuple-bound static caching, Delta
  reconstruction, and the rule that remote Monkey never reads Catalog.

## 0.4.0 - 2026-08-05

- Added strict contracts for `get_page_tree`, `preview_page_move`, `move_page`,
  and atomic `move_pages`.
- Added AI guidance for resolving hierarchy IDs, using server-owned ordering,
  reviewing signed move plans, and re-previewing stale operations.
- Added subtree, inherited-permission, cycle, optimistic-concurrency, and batch
  rollback safety guidance.
- Classified tree reads and move previews as retry-safe while keeping all move
  mutations single-attempt and idempotent.
- Updated Codex and WorkBuddy manifests to advertise page-tree organization.

## 0.3.1 - 2026-08-05

- Added a WorkBuddy/CodeBuddy plugin manifest and marketplace entry.
- Added a WorkBuddy-specific MCP launcher that resolves the bundled proxy with
  `CODEBUDDY_PLUGIN_ROOT`.
- Kept the existing Codex package, MCP configuration, profiles, and Keychain
  credential flow unchanged.
- Added cross-platform manifest regression coverage and dual-platform install
  documentation.

## 0.3.0 - 2026-08-05

- Added the nine template MCP tools to the strict server contract.
- Added safe retry classification for template reads while keeping every
  template mutation single-attempt.
- Added AI-first template discovery, preview, instantiation, authoring,
  publication, archival, and deletion guidance.
- Added contract checks for template optimistic concurrency and destructive
  confirmation requirements.
- Clarified that an idempotency key can be reused only for an exact retry with
  unchanged arguments.
- Added conflict recovery guidance requiring a fresh read, reconciliation, and
  a new key for the changed request.
- Added mandatory write-after-read checks before reporting formatting as
  verified.
- Added Markdown emphasis and destination lookup guidance to prevent escaped
  labels and silent root-level fallbacks.

## 0.2.0 - 2026-07-28

- Added named personal and company profiles with isolated endpoints and
  Keychain entries.
- Added strict compatibility checks for the full 27-tool Docmost MCP contract.
- Added directory-scoped search guidance through `rootPageId`.
- Updated mutation guidance for mandatory idempotency keys and optimistic
  versions.
- Increased the default request timeout to 90 seconds and made transport
  settings configurable.
- Added safe retries for known read-only tools on transient gateway failures.
- Preserved bounded JSON-RPC errors for HTTP conflict and rate-limit responses.
- Added `doctor` and stricter end-to-end live smoke checks.
- Documented migration away from duplicate manually configured MCP servers.
