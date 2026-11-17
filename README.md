# ShelfReady

ShelfReady takes a supplier invoice, prices it, updates Square and the scales, and builds the shelf cards.

It was built for one deli, Cheese & Crackers in Champaign, Illinois, with Square and three Tor-rey label scales. It has not been tried anywhere else.

Designed and written by Bart Basi, with assistance from Claude. Copyright 2026 Cheese & Crackers, Inc.

## What it does

- Reads a photo or PDF of a supplier invoice with the Claude API, then checks the math in code.
- Matches each line to an item in Square, and asks a person when it is not sure.
- Works out the shelf price from the pricing formulas you set.
- Shows a dry run of every change, before and after. Nothing is sent until a person approves it and presses Send.
- Updates Square first and reads it back. Then it sends the scale prices through ScaleConnect, a separate program. A person accepts every scale warning.
- Builds the shelf card sheets as Word (.docx) files, ready to print. It renders each one to PDF to check it.
- Keeps a Mailchimp fish email up to date. ShelfReady schedules it itself, on the days and time you configure, and staff can review and edit it before it goes. It cannot send an email right away or delete a campaign.
- Keeps a purchase history of every invoice, old and new, as a spreadsheet with one tab per vendor.

ShelfReady makes sure items sold by weight are sold by the pound in Square, at the scale price, whenever it changes them.

## Not affiliated, and use at your own risk

- ShelfReady is not affiliated with, endorsed by, or supported by Square, Mailchimp, Tor-rey or Anthropic.
- It changes real prices in a real register and on legal for trade scales. You use it at your own risk. Check the prices after a change.
- It reaches the scales only through [ScaleConnect](https://github.com/bartbasi/ScaleConnect). It never talks to a scale itself.

## Needs

- Node.js 24 or newer, on Linux.
- A Square account, a Claude API key, and ScaleConnect for the scales. Mailchimp is optional.
- Your own store's settings. Pricing formulas are set in Settings and stored in the database. `config/` holds the branding, the card template and the Mailchimp email layout. Your store's values are settings, not code.

## Install

```
npm ci
npm run hooks
npm run check
```

Then see:

- `docs/INSTALL.md` for first-run setup, Settings, HTTPS and phone access, running as a service and the git hooks.
- `docs/SECURITY.md` for sign in, roles and how keys are stored.
- `docs/SCALES.md` for how ShelfReady uses ScaleConnect.
- `docs/GO-LIVE.md` for moving from the Square sandbox to the live register and the scales.

Keys are entered in the app's Settings page and stored encrypted. They never go in the repo.

## License

ShelfReady is free and open source, under the GNU General Public License, version 3, with additional terms. The license is in `LICENSE`. The additional terms are in `NOTICE`.

The main one is credit. Any work based on ShelfReady, in whole or in part, must keep this line in its source code and on its About screen:

> Based on ShelfReady, designed and written by Bart Basi, with assistance from Claude. Copyright 2026 Cheese & Crackers, Inc.

A changed version must say it is changed and use its own name.

Feedback: bart@crackerscheese.com
