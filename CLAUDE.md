# ShelfReady

ShelfReady takes a supplier invoice, prices it, updates Square and the scales, and builds the shelf cards. The full brief is `store/ClaudeCodePrompt_ShelfReady.md`. Decisions made since then are in `store/docs/DECISIONS.md` and win over the brief where they differ. "I" and "me" mean Bart Basi.

## Rules

1. **The brief wins over ScaleConnect's rules only where they conflict.** Everywhere else, ScaleConnect's rules hold.
2. **Never touch ~/CCScaleApp.** Do not modify, move, restart or reconfigure anything there, including `~/.config/scaleconnect`. Do not run git there either: even `git status` rewrites its index. Reach the scales only through ScaleConnect's MCP server. Never open a socket to a scale.
3. **FRONT is the test scale.** During development, real scale writes go to FRONT only, and only when a stage's test calls for it. Automated tests use a fake scale on localhost.
4. **Square sandbox until I approve live.** No write to the live Square account until Phase 1 passes and I say so. Reading live Square to copy items into the sandbox is fine.
5. **Never auto-acknowledge a ScaleConnect warning** (price jump over 50%, drift, possible freeze, PLU change). A person accepts each one.
6. **Secrets never go in the repo, the logs, test output or the manager's screens.** Development secrets live in `~/.config/shelfready/dev.env` (mode 600). Read keys by name. Never print them.
7. **Cards must match the existing ones exactly.** The reference files are in `reference/cards/`. The layout code comes from the `cc-case-cards` skill. Do not change the geometry.
8. **Store data stays out of git**: `reference/`, `test-invoices/`, real item data, mappings and logs. Store-specific values (formulas, Square ids, branding, card template) go in config, not code.
9. **Nothing merges without code review and passing tests.** Anything touching logins, keys or network access also needs security review.
10. **Nothing goes to GitHub** until I say so.
11. **Go easy during store hours.** Tuesday to Thursday, 11am to 7pm, staff use this PC. Run installs, full test runs and LibreOffice with `nice -n 19`, one at a time.
12. **Items sold by weight are always sold by weight in Square.** Any item with a four-digit scale code must be fixed price per pound with the per-pound unit, at the same price as the scales. Check it every time such an item is touched. When a scale price changes, Square changes in the same run. See `store/docs/DECISIONS.md`.
13. **Writing.** In anything I read, no em dashes and no double hyphens. Plain, short sentences.

## Where things are

- Brief: `store/ClaudeCodePrompt_ShelfReady.md`. Decisions: `store/docs/DECISIONS.md`. Plan: `store/docs/PLAN.md`.
- `store/` is a private repo, not part of the public one. Store details, notes and follow-ups go there, never in the public repo.
- Pricing, Square conventions, card copy rules and card layout: the `anthropic-skills:cc-case-cards` skill.
- Branding for the app itself: the `anthropic-skills:cc-design` skill.
- ScaleConnect docs: `~/CCScaleApp/ScaleConnect/docs/` (read only), especially `MCP.md`.
- Agents: `.claude/agents/`.
