# Docmost Operations

## Search and read

| Goal                           | Preferred sequence                                 |
| ------------------------------ | -------------------------------------------------- |
| Discover accessible areas      | `list_spaces`                                      |
| Browse one tree level          | `list_pages` with a parent and explicit pagination |
| Inspect an ordered subtree     | `get_page_tree` with bounded depth and limit       |
| Find exact names or IDs        | `search_docs` in `keyword` mode                    |
| Find concepts or related notes | `search_docs` in `hybrid` mode                     |
| Search inside one page subtree | `search_docs` with that page's `rootPageId`        |
| Read authoritative content     | `get_page` in `markdown` format                    |

Search snippets are discovery evidence, not the authoritative page body.
`rootPageId` includes the selected readable page and its descendants. Resolve
the page first and let the server enforce space, page, and subtree boundaries.
Do not pass a title or slug where a UUID is required.

## Catalog Bundle and freshness

Catalog resolution is a diagnostic-orchestrator workflow, not a replacement
for ordinary Docmost search. Prefer the v3 start, Bundle, and Delta tools. The
v2 pair is signed compatibility, and the unsuffixed tools are immutable v1
compatibility endpoints. Neither is a silent fallback for ticket-bound v3.

For every diagnosis:

1. Generate a fresh 16-128 byte challenge and call
   `begin_catalog_resolution` with the explicit Catalog root and environment.
   Do not provide `started_at`. The returned ticket time proves only when the
   connector received the call, not when the user sent a message.
2. Use the signed, unexpired ticket once with `resolve_catalog_bundle_v3`, or
   use it with `resolve_catalog_delta_v3`, a prior signed v3 proof, and its exact
   manifest. Delta may preserve or expand roots, never shrink them.
3. Require a matching `catalog-freshness-proof.v3` from one read-only,
   repeatable-read snapshot. It must bind the ticket, challenge, current
   authorization context, complete new roots, snapshot timestamp, page
   manifest, extractor version, and Bundle fingerprint.
4. Verify every Markdown and front-matter SHA-256, strict fenced-YAML equality,
   complete page and root-change partitions, resolved-root candidate
   applicability, graph edges, unresolved references, locally derived closure
   flags, Bundle fingerprint, ticket signature, and proof signature. The profile
   must pin the response key ID and public key.
5. Consume the current closure only after that live proof succeeds.

The local proxy deliberately does not replay v2 or v3 Catalog requests. When a
transport failure leaves the outcome uncertain, discard both challenge and
ticket and begin again.

A v2 cache key is exactly `(page_id, updated_at, content_sha256)`; v3 also binds
`front_matter_sha256`. Cached Markdown may be reused only after the current
Bundle or Delta proves the same tuple. When Delta marks a page added or updated,
use the returned full page. Remove deleted tuples and reconstruct the closure
only if added, updated, removed, and unchanged form a complete partition. Never
reuse runtime facts, prior incident conclusions, tickets, challenges, or a
previous freshness proof across diagnoses.

The local `qts-ops-toolkit` orchestrator may consume and validate the Bundle in
a later integration. Remote Monkey runtime must not read Catalog or depend on
Docmost availability.

## Create and update

Before creating a page, search the selected space for the proposed title and
subject. If a matching page exists, read it and choose update or append. Do not
create near-duplicate pages merely because wording differs.

Every create, update, or append call requires an idempotency key. A key
identifies one immutable argument set:

- Reuse the key only after a transport interruption when every argument is
  unchanged.
- Generate a new key after changing content, title, icon, parent,
  `expectedUpdatedAt`, or any other argument.
- Never share a key across tools, pages, or batch items.

For updates and appends:

1. Read the current page.
2. Preserve unrelated sections and formatting.
3. Always pass the returned `updatedAt` as `expectedUpdatedAt`.
4. Submit the mutation with a fresh idempotency key.
5. Reuse that key only for an exact transport retry.
6. Re-read the page after every content mutation.
7. Compare headings, emphasis, lists, tables, links, and the intended
   destination before declaring the write verified.

If the server reports a conflict, do not replace `expectedUpdatedAt` blindly.
Read the new version, reconcile the user's requested change, and ask for
confirmation when concurrent edits would be overwritten. Because the
reconciled request contains a new `expectedUpdatedAt`, it must also contain a
new idempotency key.

For portable Markdown, separate closing emphasis from following prose with
whitespace (`**标签：** 正文`). The server tolerates punctuation-ended bold text
next to CJK prose, but explicit spacing remains clearer across Markdown
renderers. When a named parent cannot be found, do not silently create at the
space root.

## Move and organize pages

Docmost directories are pages with children. Use the same move tools for a
leaf page, a directory, or an entire subtree. Moves are limited to one space;
do not simulate a cross-space move with these tools.

For one move:

1. Use `get_page_tree` to resolve the source, target parent, and optional
   sibling reference by UUID. Use `first`, `last`, `before`, or `after`; never
   calculate or send a fractional `position` value.
2. Call `preview_page_move` with an explicit `targetParentPageId`, using `null`
   only when the user selected the space root. Supply `referencePageId` only
   for `before` or `after`.
3. Review `beforePath`, `afterPath`, subtree size, permission-inheritance risk,
   and `requiresConfirmation`. Obtain explicit confirmation when requested.
4. Call `move_page` immediately with the returned `movePlanToken`, exact
   `expectedUpdatedAt`, a fresh idempotency key, and `confirm: true` when the
   preview requires it.
5. On an expired plan or conflict, inspect the tree again and create a new
   preview. Never edit a signed plan or reuse its idempotency key for a changed
   destination.

For a batch, preview every page separately, then call `move_pages` once with
the array of `{movePlanToken, expectedUpdatedAt}` items, one idempotency key for
the exact batch, and `confirm: true`. The server applies items in array order
inside one database transaction. A moved page used as a `before` or `after`
reference must appear earlier in the array. Duplicate pages, stale versions,
invalid targets, permission failures, or a final-tree cycle roll back the whole
batch; there are no partial successes.

Moving within a space changes directory-scoped search immediately through the
page hierarchy. Do not request a vector reindex solely because a page moved.

## Templates

Prefer a published template when the requested page is repetitive or follows a
known structure:

1. Use `list_templates` with a query, space, scope, or tags to find candidates.
2. Read the selected immutable version with `get_template`; follow its purpose,
   usage guidance, and input schema.
3. Call `render_template` to validate variables and preview the title and body.
4. Call `instantiate_template` with the intended `targetSpaceId`, optional
   `parentPageId`, and a fresh idempotency key.
5. Read the created page back before reporting success.

Do not invent missing variables or silently redirect the page to another space
or parent. Pin the returned template version when reproducibility matters.
Rendering is read-only; instantiation creates a page and must never be retried
automatically after an ambiguous response.

For template authoring, `create_template` creates a draft. Use
`update_template` with the latest `updatedAt`, then `publish_template` to create
an immutable published version. Treat every changed draft or publication call
as a new request with a new idempotency key. Require explicit confirmation
immediately before `archive_template` or `delete_template`; pass the latest
`updatedAt` as `expectedUpdatedAt` and `confirm: true` only after confirmation.

## Versions

Use `list_page_versions`, `get_page_version`, and `diff_page_versions` for
inspection. Treat `restore_page_version` as destructive: show the selected
version and expected impact, obtain explicit confirmation, then restore with
the current page's `updatedAt` and a stable idempotency key.

## Attachments

Use `list_attachments` and `get_attachment` before uploading a replacement.
`upload_attachment` accepts Base64 files up to 512 KiB. If a file is larger,
report the limit and do not truncate it. Request extracted text only when it is
needed for the task. Signed URLs are temporary credentials and must not be
stored in pages or logs.

Treat `delete_attachment` as permanent. Identify the file and page, obtain
explicit confirmation, then use a stable idempotency key. Uploads also require
an idempotency key.

## Vector jobs

Reindex, retry, pause, resume, and cancel operations are mutations. Pass a
fresh idempotency key, and pass `confirm: true` where the advertised tool
schema requires it. Poll `get_index_status` or `list_index_jobs` instead of
repeatedly submitting the same operation with new keys.

## Batch imports

- Resolve the destination space and optional parent before starting.
- Search and deduplicate each document independently.
- Process writes serially unless the user explicitly requests concurrency.
- Preserve source title, source URL or path, and capture date in page content.
- Stop on the first mutation failure and return a completed/pending summary.
- Use one idempotency key per item and operation; never share one key across
  different pages.
- Treat `move_pages` as the exception: it intentionally uses one idempotency
  key for the exact atomic batch and rolls back every item on failure.
