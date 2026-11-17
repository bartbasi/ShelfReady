# Security

This describes how ShelfReady is built to be safe. It does not describe any one install. For how to set up HTTPS, see `docs/INSTALL.md`.

## What it protects

- **The keys in Settings.** The Claude API key, the Square access token, the ScaleConnect token and the Mailchimp API key. Whoever holds the Square token can change prices and stock in the shop. Whoever holds the ScaleConnect token can change the scales. Whoever holds the Mailchimp key can email the whole list.
- **The power to approve an invoice.** Approving writes to Square and the scales.
- **The Settings and Users screens.** Only an admin may use them.
- **The audit log.** It records who did what.

## What it defends against

- Someone on the shop network who has no account, or who guesses a password.
- A manager account used beyond its role, or a lost phone that is still signed in.
- A web page that tries to make a signed-in browser post to ShelfReady (CSRF).
- A copy of the database or the `data/` folder leaking, for example in a backup.
- Mistakes: a secret printed in a log, shown on a screen, or committed to git.

Out of scope: someone with a shell as the same user that runs ShelfReady. They can read the master key and the database. Use full disk encryption and a good login on the PC.

## Roles and sign in

There are two roles. An **admin** can do everything. A **manager** can run, review, approve and send invoices, and download cards, but cannot open Settings or Users.

- **Where it is enforced.** Every route declares `public`, `user` or `admin`. One hook enforces it before the request body is read. A route that declares nothing is refused, so a new route cannot be left open by mistake. A test checks that a manager gets 403 on every admin route.
- **Passwords.** scrypt, with a random salt per user, 12 to 256 characters. The hash settings are stored with each hash, so they can be raised later. An unknown name is checked against a dummy hash, so it takes as long as a wrong password. A password an admin sets must be changed at next sign in.
- **Users are disabled, never deleted.** The audit log then always names a real account.
- **Sign in throttling.** After 5 failures for a name, or 20 for an address, each further failure doubles a lockout that starts at 30 seconds and stops growing at 15 minutes. It is stored in the database, so a restart does not reset it. The message is the same for every failure, so a lockout does not reveal which accounts exist. The typed username is never written to disk. The throttle keys it with a keyed hash.
- **Sessions.** A random token in an HttpOnly, SameSite=Strict cookie. The server keeps only its SHA-256. "Remember this device" lasts 30 days. Without it, a session ends after 2 hours idle or 12 hours in all. The role is read on every request, so a change takes effect at once. Disabling a user or resetting a password ends all that user's sessions. With TLS on, the cookie is also Secure and carries the `__Host-` prefix.
- **Recent password.** Any admin change, and also Send and accepting a scale warning, needs the password typed in the last 15 minutes. That limits what a lost phone can do.

## CSRF

Three layers. SameSite=Strict cookies. Every POST must carry an Origin header (or a Referer) from the configured list. Every form carries a per-session token. The sign in form has its own token, so another site cannot sign a browser in to an account it chooses.

## Keys and settings at rest

- Every setting is encrypted with AES-256-GCM. Each write uses a fresh nonce, and the setting's name is bound to it. Moving a value to another name, or changing a byte, fails the check. A damaged row is shown as damaged and is never used. A new value overwrites it, so one bad row cannot lock the admin out.
- The master key is a 32-byte random key in a file, by default `~/.config/shelfready/master.key`. It is made with mode 600 in a mode 700 folder. It must sit outside the repo and the data folder. The file must be a plain file owned by the same user, with no group or other access. It cannot be a symlink. ShelfReady never overwrites an existing key file. If the key is missing but the database holds settings, it stops and asks you to restore the key, rather than make a new one that could never read them.
- Secret fields are write only. The page shows "Not set", "Set" or "Damaged", and for long values the last 4 characters. A failed save never echoes a secret back. A blank field keeps the current value.
- A key belongs to one place. A Square token is stored with the environment it was entered for, and is sent only there. A ScaleConnect token is dropped when the address changes, unless a new token is entered in the same save. So a stolen admin session cannot aim an existing key at another server.
- Back up the master key apart from the database.

## What it can reach

- **Square.** Each client is pinned to one origin and allows only a short list of calls. It refuses redirects and sets a time limit. It never deletes anything. Writes update existing objects only, using the full object read just before. Live Square needs two switches: `allowSquareProduction` in the server config, and the Production setting. Neither alone is enough.
- **Scales.** ShelfReady reaches scales only through ScaleConnect, and never opens a socket to a scale. See `docs/SCALES.md`. Live ScaleConnect needs `allowLiveScaleConnect` and one fixed address in the config. The address in Settings must match it exactly. Before the token is sent to an address on the same PC, ShelfReady checks that the listener there belongs to the same user.
- **Mailchimp.** A fixed list of nine calls, checked on method, path, query and body before each is sent. Four are reads: audience names and counts, the campaign list, one campaign, and its content. Five change one campaign: copy it, rename it and set its settings, replace its content, schedule it and unschedule it. There is no send, test send, delete, list change or member call. Writes are off until `allowMailchimpWrites` is set in the config.
- **Risky environment.** Every client refuses to run while a proxy, a custom certificate store or a TLS key log is set in the environment or Node flags, so a key cannot be diverted.
- **Written text.** Square, Mailchimp, scales and invoices can all hold text an attacker might control. It is shown only through the escaping template, never as markup or links.

## Network exposure

- With TLS off, the server listens on loopback only.
- With TLS on, it also listens on each address in `listenAddresses`. These must be private addresses written out: 10/8, 172.16/12, 192.168/16, Tailscale's 100.64/10 or IPv6 fc00::/7. The config refuses `0.0.0.0`, public addresses and names.
- Any Host header not in `allowedHosts` is refused before anything else happens. That stops DNS rebinding.
- `trustProxy` must be false. No client can choose the address the throttle and logs see.
- TLS 1.2 and 1.3 only, with modern ciphers. A stalled handshake is dropped. Headers and request bodies must arrive within time limits. Each device may hold only a few connections.
- HSTS is sent to the allowed names, never to localhost. Start with a short value and raise it to a year once the certificate has worked for a week. Then a phone that has visited cannot be talked past a false certificate.
- Browser hardening: a strict content security policy with no inline script or style, frame blocking, no sniffing, and no caching of pages.

Advice for your install:

- Keep ShelfReady on the shop network. Do not forward a port to it from the internet.
- Keep ScaleConnect off any network that does not need it. It can change the scales. If you share the PC over a VPN, allow only ShelfReady's port.
- Let the firewall allow only the shop network, or only the phones that need it, to ShelfReady's port.
- Install the private certificate on a phone only after checking its fingerprint. Renew it each year.
- Run ShelfReady as a normal user, never root.

## Logs and audit

- Request logs hold the method, the path without the query, and the remote address. No headers, no bodies. A redaction list covers keys, tokens, passwords and cookies in case one is logged by mistake. A test captures every log line through a full session and checks no secret appears.
- The audit log is append only: database triggers refuse update and delete. It records sign ins, failed sign ins for real accounts, user and settings changes (secrets only as "set" or "cleared"), and every approval and send, with the user's name. Failed sign ins for unknown names are only counted per hour, so spraying names cannot grow it without bound.

## Uploads

- Only two routes take files: the invoice run upload and the old invoice upload for the purchase history. Each is in its own scope, and every other route refuses multipart. Both check sign in, role, a per-user hourly limit, a size limit, a daily budget and free disk space before they read the body.
- Each file is checked by its first bytes, never its name. A file is stored under a random name, mode 600, and is served only to signed-in users, with a locked-down content policy.
- Reading an invoice costs money. Per-invoice and per-day spending limits stop it. Past a limit, an admin must approve, with a recent password.

## Reporting a problem

Email the address in the README. Do not post a security problem in public.
