# Going live with Square and the scales

Everything starts in the Square sandbox and, for scales, against a test harness or one test scale. This guide moves an install to the live Square account and to every real scale. Do it outside shop hours.

Live means two things at once:

- **Square (live).** ShelfReady reads the real catalog and changes real prices and stock.
- **The shop scales.** ShelfReady sends prices to every scale through ScaleConnect.

They go live together. A price sold by weight must be the same in Square and on every scale, so live Square refuses to start unless the config names every scale, and a live invoice always goes to all of them.

## What stays the same

- Nothing is sent until a person approves a dry run and presses Send.
- Square goes first and is read back. The scales follow only when Square is fully done.
- A person accepts every ScaleConnect warning. ShelfReady never accepts one on its own.
- A scale that may be frozen is left out and never retried on its own. A lost reply is looked up, never sent again.
- If a scale misses a price, Square keeps its new price. That scale is marked pending, with a resend button.

See `docs/SCALES.md`.

## Before you start

1. The sandbox run-through worked, from upload to Send.
2. ScaleConnect is running on this PC as the same user as ShelfReady, at an address like `http://10.0.0.20:9000/mcp`. Use your real address and port. ShelfReady checks that the program listening there belongs to the same user before it sends the token. If ScaleConnect runs as another user, every send stops before Square, and says so.
3. No scale is flagged as maybe frozen in ScaleConnect.
4. No sandbox invoice is half sent. Finish or stop each one. Once live is on, a sandbox invoice can no longer be sent.

## 1. Find the live Square token and location

1. Open the Square Developer Dashboard and your app.
2. Switch to Production. Check that Credentials shows a Production access token. Do not copy it yet. Copy it at the start of step 5, so it does not sit in the clipboard meanwhile.
3. Under Locations, note the shop's location id.

ShelfReady needs to read and write items and inventory, and to read locations: `ITEMS_READ`, `ITEMS_WRITE`, `INVENTORY_READ`, `INVENTORY_WRITE` and `MERCHANT_PROFILE_READ`. A personal access token cannot be limited to these. It can do anything in the account. So ShelfReady limits itself. It sends only a short list of calls, never creates or deletes anything, and refuses every other call before it is sent.

## 2. Stop ShelfReady and back up the database

```
scripts/net/service.sh stop
(umask 077; sqlite3 data/shelfready.sqlite3 ".backup data/shelfready-before-live.sqlite3")
```

## 3. Change the server config

Edit `config/local/server.json`. Keep what is there and add:

```json
"allowSquareProduction": true,
"allowLiveScaleConnect": true,
"liveScaleConnectUrl": "http://10.0.0.20:9000/mcp",
"scaleNames": ["SCALE-1", "SCALE-2", "SCALE-3"],
"writeScales": ["SCALE-1", "SCALE-2", "SCALE-3"]
```

- `allowSquareProduction` lets Settings choose live Square. Without it, live Square is refused everywhere.
- `allowLiveScaleConnect` and `liveScaleConnectUrl` allow ScaleConnect at that one address. The address in Settings must be exactly the same.
- `scaleNames` must be the scales ScaleConnect reports. `writeScales` must name all of them.
- `mailchimpFromSandboxRuns` must be off or absent. `devCatalogFile` must be absent.
- `allowMailchimpWrites` lets live invoices update the fish email. Leave it off if you do not use that.

The server checks these at start. If something is wrong, it does not start, and says why in `data/logs/server.log`.

## 4. Start ShelfReady

```
scripts/net/service.sh start
```

## 5. Change Settings

Sign in as an admin and open Settings. It asks for your password again.

1. Copy the Production access token from the Square Developer Dashboard.
2. Square. Environment: Production (live store). Paste the token. Put the location id in Location id. The token and the environment go in the same save. A token belongs to one environment, and changing the environment without a new token removes the old one.
3. ScaleConnect. Enter the address from step 3 and the ScaleConnect token in the same save. Changing the address clears the old token.
4. Save. Then copy something else, so the token leaves the clipboard.

Check that Settings now says, in red, that live Square is in use, that the saved token was entered for live Square, and that sends go to the shop scales.

## 6. Check the pages

- The upload page and the invoice list say the Square catalog is live, with a red LIVE tag.
- An invoice and its dry run say live too.
- The Send page says it sends to live Square, then to the named scales.

## 7. The first live invoice

Pick a small one with one item sold by weight.

1. Upload, review and make the dry run. It says it was made from live Square.
2. Approve, then Send with every scale ticked. ShelfReady refuses fewer.
3. ShelfReady changes Square, reads it back, then asks ScaleConnect for one preview.
4. Read every warning and difference. Tick each one you accept. Then send to the scales.
5. Check three things apart: the scales, Square and the cards. A partial result is not done.

Any item with a scale code is sold by weight in Square: a fixed price per pound at the scale price. ShelfReady checks this each time it touches such an item, and switches an item that is set to "price at the register". The review screen shows each switch first.

## 8. Later: the fish email drift check

When the first live invoices look right, you can add `"mailchimpDriftCheck": true` to the config and restart. Each fish email edit then sets any email price that differs from the register to the register price. It is off by default.

## Going back to the sandbox

Change Settings first, while live is still allowed, then the config. Then the live token is removed in the same save that leaves live, and is never left behind for the sandbox.

1. Finish or stop every live invoice in progress.
2. In Settings, in one save: Environment Sandbox (test), the sandbox token, and the sandbox location id.
3. Check Settings says the sandbox is in use and the saved token was entered for it.
4. Stop ShelfReady: `scripts/net/service.sh stop`.
5. In `config/local/server.json`, set `allowSquareProduction` and `allowLiveScaleConnect` to false, remove `liveScaleConnectUrl`, set `writeScales` to the one test scale, and remove `mailchimpDriftCheck`.
6. Start ShelfReady: `scripts/net/service.sh start`.
7. In Settings, set the ScaleConnect address to your test harness, with its token in the same save.

If you change the config first by mistake, ShelfReady still never sends the live token to the sandbox. It sends a token only to the environment it was entered for. Enter the sandbox token to fix it.

Item matches and card links made in live Square point at live items, which the sandbox does not have. In the sandbox those lines ask a person again. Going back to live later, the live ones are still there.
