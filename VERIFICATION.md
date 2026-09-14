# TDeck verification

## Completed

- `npm run check`: TypeScript, all **116 tests**, and production build pass. `npm run pack` creates `release/tdeck-0.1.0.zip`; archive entries verified.
- Existing Brave profile is signed in to X.
- Production extension loaded into Brave from `dist`, using the existing signed-in profile.
- Real keyword, account, and private-list columns populate with actual posts and engagement counts.
- Own-list discovery excludes recommendations, distinguishes duplicate names, resolves the selected native card to its numeric URL, and adds a working list column. No X lists were created, followed, pinned, or edited.
- Existing columns and cached posts survive extension reload.
- Independent account-column scrolling leaves the adjacent keyword and list columns in place.
- Light and dark appearance, comfortable and compact density, local save/unsave, and global pause/resume exercised in the installed dashboard.
- Named-layout save, persistence after a dashboard reload, restore confirmation, and restoration of the saved three-column workspace verified in Brave. The initial layout remains saved as **My X workspace**.
- All three source types report Connected after refreshing through the managed source window. Real avatars and images are present in each; an actual post image opens in the in-deck lightbox.
- A scheduled keyword refresh advanced its successful-update timestamp without a manual refresh and remained Ready.
- Older account pagination adds posts while neighboring columns stay in place. The account cache grew from 6 to 9 posts during the check, without source errors or dashboard focus changes.
- Source-window diagnostics confirmed a normal, unfocused window. The dashboard stayed focused throughout source rotation and pagination.
- Temporary DOM diagnostics removed from the shipped code.
- README screenshot captured from the actual dashboard in Brave at a 1440×900 CSS viewport (2× resolution), using only fictional posts and bundled demo artwork. The page-only PNG excludes browser chrome and account data. Demo assets load locally, its state stays in page-local memory, and its code is excluded from the extension build.
- Source-parser, core-state, mounted UI, and background-worker tests cover untrusted extraction, source ownership, navigation identity, partial pagination failures, list discovery/selection, local validation, automatic insertion and pixel-offset reading-position preservation.

## Live findings addressed during development

- A failed optional scroll discarded a successful initial read. Refresh and older-post loading were separated, and valid partial pagination results are retained when a later scroll times out.
- Reload acknowledgement could precede document navigation. Refresh now verifies a new document identity before accepting its snapshot.
- X list snapshots intentionally strip fragments; ownership verification now checks the actual browser tab separately from the sanitized URL.
- Brave froze every source in a collapsed source-tab group. Expanding only TDeck's group resumed the pending reads without activating a source.
- X rendered text but no native image elements in inactive tabs. Moving sources to a managed, unfocused normal window made their media render while the dashboard retained focus. The production implementation validates tab ownership, window focus, minimization, and the active source before collection.

## Verification scope

- Live browser acceptance used the user's existing Brave profile on macOS. Chrome uses the same Chromium build target, but was not separately installed or live-tested.
- Browser restart persistence, lost worker leases, auth expiry, rate-limit states, minimized/focused/contaminated source windows, editing, and configuration import/export have regression coverage. The user's browser was not quit and their X account was not logged out to force these conditions.

## Product boundaries

- Uses periodically refreshed normal X pages. Results are not a guaranteed complete realtime stream.
- Native X completes compose, reply, repost, and like actions; TDeck supplies reading, copying links, and locally saved posts.
- Images have an in-deck lightbox; video playback opens on X.
- DOM status text currently recognizes English. X markup changes may need adapter updates.
- AI Recap is an optional later phase, recorded in `PLAN.md`; no AI provider is connected and no posts are sent to an AI service.
