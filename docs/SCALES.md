# Scales

ShelfReady sends scale prices through [ScaleConnect](https://github.com/bartbasi/ScaleConnect), a separate program. ShelfReady never opens a connection to a scale. If you have no scales, leave the ScaleConnect settings empty.

## How it connects

ShelfReady talks to ScaleConnect's MCP server over http. You enter its address and token in Settings. The scale list comes from ScaleConnect and is shown read only. Add or remove scales in ScaleConnect's own config.

ShelfReady uses these ScaleConnect tools:

- `scale_list_scales`, to check the scale names match its config.
- `scale_search_items`, `scale_get_item` and `scale_read_items`, to look at items.
- `scale_preview_changes`, then `scale_apply_changes` with the preview id. This is the only way a price reaches a scale.
- `scale_get_change`, to look up the result of an apply by preview id.
- `scale_compare_scales`, for one named scale. This clears a "may be frozen" flag.
- `scale_preview_settle_drift`, to bring a scale that missed a price back in line with the catalog.

## Square first, then the scales

A scale price change goes to Square in the same run.

1. ShelfReady changes Square, reads it back and checks it.
2. Only then does it ask ScaleConnect for one preview of every by-weight price in the run.
3. A person reads the preview, ticks each warning, and sends it.

If Square fails, no scale is touched. If a scale fails, Square keeps its new price. That scale is marked pending, and the page lists the prices it is missing. A resend button then does the repair.

ScaleConnect's own advice is scales first. ShelfReady follows its own order, which is Square first. Decide whether that suits you before you go live.

## Items sold by weight

An item with a four-digit scale code is sold by weight in Square: a fixed price per pound at the scale price. ShelfReady checks this each time it changes such an item. It refuses to go on if Square is set to take the price at the register, or if the two prices differ. It switches the item in the same run, and shows the switch in review first.

## Warnings need a person

ScaleConnect warns about a price jump over 50 percent, a scale that differs from its catalog (drift), a possible freeze, a delete, a PLU change, a scale left out, and a change aimed at fewer scales than usual.

ShelfReady shows every warning and every drift token on the page. Each needs a tick from a signed-in person, who must also have typed their password in the last 15 minutes. The code never sets `acknowledge_warnings` on its own. If the warnings change between the preview and the tick, the tick is refused and the new ones are shown.

## May be frozen

Reading a real scale can freeze it, and a frozen scale needs a person to reboot it. ScaleConnect flags a scale that does not answer with `may_be_frozen`.

- ShelfReady stops reading and writing that scale. It never retries it on its own.
- A preview that found a scale that may be frozen is stored as blocked and cannot be applied. A new preview leaves that scale out, with a warning for a person to accept.
- The scale is marked pending. To resend, a person confirms someone has looked at the scale. ShelfReady then compares that scale alone, which clears the flag if it answers. Only then does it offer a settle for each missed price.

## Never twice

- An apply can take minutes. A timeout does not stop it. ShelfReady stores the step before the call. After a lost answer or a restart, it only looks the result up by preview id, and never applies again.
- An apply that never ran, and is still reported as not applied five minutes after its preview expired, is recorded as never applied. A person can then make a new preview.
- A preview or compare cut short by a restart is not run again on its own, because it reads scales.
- Previews last 15 minutes.
- Only `success` with every scale `verified` counts as done. Anything else is partial, and the page says which scales have it.

## Which scales may be written

The server config limits this:

- `scaleNames` lists the scales ScaleConnect should report.
- `writeScales` lists the only scales a send, preview, resend or settle may write to. The default is one test scale.
- `allowLiveScaleConnect` and `liveScaleConnectUrl` allow ScaleConnect at one address. Without them, ShelfReady sends only to a test ScaleConnect on this PC.
- With live Square on, `writeScales` must name every scale.

See `docs/GO-LIVE.md` for the steps and `docs/SECURITY.md` for how the token is protected. The automated tests use a fake ScaleConnect on this PC, never a real scale.
