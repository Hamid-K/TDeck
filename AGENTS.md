# TDeck development

- Canonical repository: `https://github.com/Hamid-K/TDeck.git`.
- Use Git to track source, configuration, documentation, and tests. Keep dependencies, generated builds, release archives, local credentials, and browser account data out of commits.
- Preserve unrelated user changes. Keep commits focused, and never force-push or rewrite published history without an explicit request.
- Run `npm run check` before publishing implementation changes. Record live browser checks and untested boundaries accurately in `VERIFICATION.md`.
- Publish versioned GitHub releases with the production extension ZIP, SHA-256 checksum, and concise notes. Keep package and manifest versions aligned, verify archive contents, and verify uploaded assets before handoff.
- Use synthetic accounts, lists, and posts in test fixtures; do not commit data copied from a signed-in account.
- Keep optional AI Recap work separate from core maintenance. It remains disabled until the provider and data-sharing policy are agreed with the user.

# GitHub writing

- Write pull-request titles and descriptions, issue updates, review replies, commit messages, and other GitHub notes as concise human engineering notes.
- Lead with the outcome and purpose. Include only decision-relevant scope, risk, verification, and follow-up.
- Keep detail proportional to the change: a small documentation change usually needs one to three sentences; a normal change needs a short summary and validation.
- Prefer short paragraphs or a few useful bullets. Remove repeated context, file-by-file narration, obvious implementation details, raw test output, generic boilerplate, and self-congratulation.
- Do not post comments that merely narrate tools or steps taken. Report facts, decisions, blockers, or requested follow-up instead.
- Respect required repository templates, but keep every applicable section terse. Reread GitHub notes before publishing and remove anything that does not help a reviewer understand or decide.
