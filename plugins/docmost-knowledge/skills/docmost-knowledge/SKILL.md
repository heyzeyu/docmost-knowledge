---
name: docmost-knowledge
description: Use a private Docmost knowledge base through permission-scoped MCP tools. Trigger when the user asks to search, read, cite, capture, create, update, append, move, reorder, template, instantiate, version, restore, attach, index, organize pages, or resolve a freshness-verified fact Catalog in Docmost.
---

# Docmost Knowledge

Use the `docmost-knowledge` MCP server for Docmost work. Prefer it over browser
scraping or direct database access.

## Core workflow

1. Call `list_spaces` when the target space is not already established. Use
   only spaces returned by the server.
2. Search before reading or writing. Default to `search_docs` with `hybrid`
   mode; use `keyword` for exact identifiers and `semantic` for conceptual
   recall. When the user names a page subtree or directory, resolve its page ID
   and pass it as `rootPageId`; do not imitate directory scoping with title
   keywords.
   Use `list_pages` only to browse one level of a known tree. Use keyword
   search to locate a named destination without recursively walking every
   parent.
3. For page or directory organization, call `get_page_tree` to resolve exact
   IDs and ordering, then `preview_page_move`. Never infer a parent from its
   title or supply a raw position. Execute the returned plan immediately with
   `move_page`, or combine individually previewed plans with `move_pages`.
4. Before creating repetitive or structured content, call `list_templates`.
   When a relevant published template exists, inspect it with `get_template`,
   validate variables with `render_template`, then create the page with
   `instantiate_template`. Do not bypass an applicable template merely because
   an ordinary `create_page` call is shorter.
5. Read the selected page with `get_page` in Markdown. Do not infer missing
   content from snippets.
6. For answers based on Docmost, cite the page title and returned page ID or
   slug. Link only when the tool returned a trustworthy URL.
7. Write only when the user asks to capture or change knowledge. Reuse an
   existing page when it represents the same subject.

## Catalog workflow

- Use `resolve_catalog_bundle` only when a diagnostic orchestrator needs a
  structured `qts-fact-catalog.v1` reference closure. Ordinary knowledge search
  continues to use `search_docs` or `semantic_search_docs`.
- Start every diagnosis with a fresh challenge of 16-128 UTF-8 bytes. Never
  carry a challenge or freshness proof into another diagnosis.
- Use `resolve_catalog_bundle` when there is no revalidated local manifest. Use
  `resolve_catalog_delta` with the previous fingerprint and page tuples only
  to revalidate a static cache and reconstruct the current closure.
- Reuse cached Markdown only when the current proof returns the exact same
  `(page_id, updated_at, content_sha256)` tuple. Never reuse prior runtime
  facts, incident conclusions, or unverified page content.
- Treat missing Catalog tools as an unsupported optional capability, not as a
  failure of ordinary Docmost work. Treat one missing tool, a challenge
  mismatch, hash mismatch, incomplete Delta partition, or invalid fingerprint
  as a hard Catalog validation failure.

## Write safety

- Read the current page immediately before `update_page` or `append_page`, and
  always pass its `updatedAt` as `expectedUpdatedAt`. A missing or stale value
  is a conflict that requires a fresh read, not a reason to bypass protection.
- Generate one non-empty idempotency key for every mutation, including create,
  update, append, move, delete, restore, attachment, template, and reindex
  operations. Reuse it only when retrying the same request with unchanged
  arguments. Any changed content, title, variables, destination,
  `expectedUpdatedAt`, or other argument requires a new key.
- Use `append_page` for journals and additive notes. Use `update_page` for a
  coherent replacement.
- After a successful content mutation, read the page back in Markdown and
  compare the requested headings, emphasis, lists, and tables before reporting
  that formatting was verified.
- Prefer whitespace after closing Markdown emphasis, especially before CJK
  prose: write `**标签：** 正文` rather than `**标签：**正文`.
- Do not silently fall back to a space root when a named destination page is
  missing. Report the missing destination or use only an explicitly approved
  fallback.
- Use the exact `movePlanToken` and `expectedUpdatedAt` returned by the latest
  `preview_page_move`. Re-preview after expiry or conflict. Pass `confirm: true`
  when the preview reports `requiresConfirmation`; `move_pages` always requires
  confirmation and one idempotency key for the whole atomic batch.
- Require explicit user confirmation immediately before page deletion,
  attachment deletion, page restoration, version restoration, template
  archival, template deletion, a risky subtree move, or any batch move. Pass
  `confirm: true` only after confirmation.
- Never broaden access or work around server-side space permissions.
- Do not ask the user to paste the bearer token. Authentication belongs in
  macOS Keychain.

## Failure behavior

- If the MCP server is unavailable, report whether the failure is local
  startup, Keychain authentication, transport, or server authorization. Do not
  expose credentials or raw authorization headers.
- Stop an ordinary multi-item workflow after the first failed mutation. For
  `move_pages`, report that the server rolled back the whole atomic batch; do
  not claim any item moved.
- On a version conflict, re-read the page and ask before overwriting materially
  changed content. The reconciled call is a changed request and must use a new
  idempotency key. On rate limiting, wait for the indicated retry window.
- Never silently truncate content or attachments.

Read [operations.md](references/operations.md) before mutations, template or
version operations, attachment work, or multi-page imports.
