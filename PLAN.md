# TDeck implementation plan

Build a polished Chromium Manifest V3 extension with a dedicated dashboard tab for independent, automatically refreshed X search columns. Use the account already signed in to X in the same browser profile.

## Product defaults

- Dedicated dashboard tab (confirmed).
- Search/keyword, account, and list columns (confirmed); editable titles, colors, order, and width.
- Automatically insert new posts at the top (confirmed), preserving the reader's position when scrolled down. Offer queued arrivals as an optional setting.
- Dark and light themes, comfortable/compact density, local saved posts, keyboard shortcuts, import/export, and useful loading/error states.
- Local storage only. No backend, account credentials, developer API subscription, or analytics.
- Named layouts: save and restore column sources, order, widths, filters, and display preferences across browser restarts; keep bookmarks and account sessions separate.

## Delivery checkpoints

Core delivery verified on 2026-09-14; results and remaining product boundaries are recorded in `VERIFICATION.md`.

1. Verify native Latest search and the extension's background-page extraction against the existing Brave session.
2. Build the session-backed source adapter, persistent refresh scheduling, pagination, deduplication, and error recovery.
3. Build and visually verify the complete responsive dashboard and column editor.
4. Validate the packaged extension and exercise real search, automatic updates, independent scrolling, persistence, and recovery in Brave.

## Integration contract and limits

The extension reads posts rendered by ordinary X pages in its own source tabs. It does not store login cookies or call undocumented authenticated endpoints. Live testing showed that X withholds images in hidden tabs, so sources use one managed, unfocused normal window; the dashboard retains focus. This window must remain open and unminimized. Sources are created only after the user starts connecting a column. Refreshes are staggered, pauseable, and back off on errors. User inspection of the source window suspends automatic manipulation. X's search visibility and rate limits still apply; polling cannot promise an exhaustive realtime stream. Changes to X's markup may require adapter maintenance.

## Verification

Meaningful unit checks cover feed merging, input validation, untrusted post data, parser behavior, source ownership, scheduling, and recovery. Browser checks cover installation, actual signed-in results, two independent searches, older-post loading, background refresh, unread insertion, reload persistence, theme/density, and responsive layout. Never label sample data or unverified source state as live.

## Optional follow-up: AI Recap

Only after core acceptance is complete. An opt-in, fixed recap box above each selected column summarizes its recent posts and prioritizes new, important developments. Use a topic-neutral prompt that infers context from the column and its posts, not topic-specific CVE, war, or other templates. Link claims back to source posts, show the covered time range and last refresh, distinguish reporting from corroborated facts, and preserve material uncertainty or disagreement. Treat post text as untrusted source material, never as instructions. Deduplicate repeated reporting and explain when the available posts are insufficient for a useful recap.

Choose the AI provider, data-sharing policy, and cost controls with the user before enabling network-backed summaries. Disabled by default; do not transmit private-list content or other column data to an AI service without explicit approval. This is low priority and must not block delivery of the stable core.
