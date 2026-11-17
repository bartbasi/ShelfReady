# Install

This guide sets up ShelfReady on a small Linux PC in a shop. Run every command as a normal user, never as root. ShelfReady refuses to start as root.

Run the commands from the ShelfReady folder. The examples use `10.0.0.20` for the PC's address, `10.0.0.45` and `10.0.0.46` for two phones, `10.0.0.0/24` for the shop network and `shelfready.example.com` for the name. Use your own. ShelfReady accepts only shop network addresses here: 10/8, 172.16/12 or 192.168/16 (and Tailscale's 100.64/10).

## What you need

- Linux, with Node.js 24 or newer.
- LibreOffice and poppler (`poppler-utils` on Debian). They check the shelf card sheets. The check runs at low priority.
- `curl`, `openssl` and `ss`. The network check script uses them.
- A Claude API key. It reads invoices and writes card copy.
- A Square account. Start with the Square sandbox.
- ScaleConnect, if you have label scales. See `docs/SCALES.md`.
- A Mailchimp API key, only if you want the fish email.

## 1. Install and check

```
npm ci
npm run hooks
npm run check
```

`npm run check` runs the type check and every test. It takes a while. On a shared PC, run it when no one is using the machine, or put `nice -n 19` in front.

## 2. First run

1. Make a config file at `config/local/server.json`. Git ignores that folder. An empty file with `{}` in it is fine to begin with. The defaults listen on this PC only, at `http://127.0.0.1:3000`. To keep the file somewhere else, set `SHELFREADY_CONFIG` to its path.
2. Make the first admin. The script asks for a username and a password, and never shows the password:

   ```
   node scripts/admin/create-user.ts
   ```

3. Start the server:

   ```
   node src/server/main.ts
   ```

4. Open `http://127.0.0.1:3000` in a browser on that PC and sign in.

On first start ShelfReady makes its master key at `~/.config/shelfready/master.key` and its database in `data/`. Back up the master key apart from the database. Without it the saved settings cannot be read. Never put either in git.

If the only admin is locked out, run `node scripts/admin/reset-password.ts`. Its header shows the options.

## 3. Settings

Open Settings as an admin. It asks for your password again. Keys are write only: a saved key shows as "Set" and is never shown again. They are stored encrypted.

- **Claude.** The API key, the two models, and spending limits per invoice and per day.
- **Square.** The environment, the access token and the location id. A token belongs to one environment. Production stays locked until the server config allows it (see `docs/GO-LIVE.md`).
- **ScaleConnect.** Its address and token. The list of scales comes from ScaleConnect.
- **Pricing.** The shelf price formula, the size of a price change that needs its own tick, and any formulas for single vendors. The shelf price is (cost plus add before) times the multiplier, plus add after, rounded. These are stored in the database. The default formula is 2 times cost plus 1.00, rounded up to .99. Change it to suit your shop.
- **Cards.** The path to your card config file.
- **Mailchimp.** The API key, for the fish email. See the README.

Other install values live in `config/`. That holds your branding, the card template and the Mailchimp email layout.

- **Branding.** Copy `config/branding/cheese-and-crackers.json` to a new name, change it, and point `brandingFile` in `config/local/server.json` at it.
- **Cards.** Copy `config/cards/cheese-and-crackers.json` to a new name, change it, and enter its path under Cards in Settings.
- **Mailchimp.** The email layout is always `config/mailchimp/cheese-and-crackers.json`. Edit that file in place: the list name, title prefix, time zone, fish days, send time and checks. Do not put your real list id there. Put it in `config/local/mailchimp.json`, which git ignores:

  ```json
  { "list": { "id": "your-list-id", "name": "Your list name" } }
  ```

  `list.id` is needed, and `list.name` is optional. The file may also hold a `campaigns` map of names to campaign ids, for the one-off scripts in `scripts/mailchimp/`. Until a list id is set, ShelfReady treats Mailchimp as not set up.

Add more users on the Users page. A manager can run and send invoices. Only an admin can change Settings or users.

## Fonts for the card check

ShelfReady checks each card sheet by rendering it with LibreOffice and reading the result with poppler. The check means nothing unless the card fonts are installed on the system. By default these are Fraunces and Space Grotesk. They are named in the `fonts` part of your card config. If a font is missing, the check says so and the sheet is not trusted. Look over the printed pages before cutting.

The fonts ship with ShelfReady in `src/server/static/fonts/`. To install them for your user:

```
mkdir -p ~/.local/share/fonts/shelfready
cp src/server/static/fonts/*.ttf ~/.local/share/fonts/shelfready/
fc-cache -f ~/.local/share/fonts
fc-list | grep -iE "fraunces|space grotesk"
```

The last command should list both. The licenses are in the same folder (`OFL-*.txt`). If you use other fonts in your card config, install those the same way. They are variable fonts, so the PDF may show a name like `Fraunces-9ptBlack` for every weight. That is normal.

Run `fc-cache` as the same user that runs ShelfReady. Then run a card check again.

## 4. HTTPS and phones

Phones need HTTPS. ShelfReady refuses plain http on anything but this PC. The steps below use a private certificate for your own name, which each phone installs once. They keep ShelfReady on the shop network only, with nothing open to the internet.

### Pick a name and an address

1. Give the PC a fixed address on your router, for example `10.0.0.20`.
2. Make a DNS record for the name. Either add an A record in your own domain, `shelfready` pointing to `10.0.0.20`, or add a local DNS entry in the router. Check on the PC: `getent hosts shelfready.example.com` must print `10.0.0.20`. If the PC never sees it, the router may block public names that point at private addresses ("DNS rebind protection"). Add the domain to the router's exceptions, or use the router's own DNS entry.
3. Use the name, not the bare address. Browsers then refuse to let anyone click past a certificate warning (HSTS).
4. In the router, forward no port to the PC, and turn off UPnP.

### Make the certificate

```
node scripts/net/private-cert.ts make shelfready.example.com
```

This makes a small certificate authority that can vouch only for that name. It signs the server certificate, then destroys the authority's key. It prints a SHA-256 fingerprint. Write it down. You check it on each phone. The certificate lasts at most 397 days. The file for the phones is `~/.config/shelfready/tls/ca.crt`.

### Turn HTTPS on

Add these keys to `config/local/server.json`:

```json
{
  "port": 8443,
  "tls": { "enabled": true },
  "listenAddresses": ["10.0.0.20"],
  "allowedHosts": ["shelfready.example.com"]
}
```

The server always listens on 127.0.0.1 too. It refuses `0.0.0.0`, public addresses, and any Host header not in `allowedHosts`.

### Firewall

Let only the shop network reach the port. With `ufw`:

```
sudo ufw allow from 10.0.0.0/24 to 10.0.0.20 port 8443 proto tcp
```

If you want to let in only certain phones, give each phone a fixed address (a DHCP reservation, with the phone's Wi-Fi address set to stay the same for that network) and add one rule per phone, for example:

```
sudo ufw allow from 10.0.0.45 to 10.0.0.20 port 8443 proto tcp
sudo ufw allow from 10.0.0.46 to 10.0.0.20 port 8443 proto tcp
```

This keeps casual visitors out only. The sign in is what guards the page.

### Start it and check it

```
scripts/net/service.sh start
scripts/net/check.sh
```

Every line of the check should say OK.

### Install the certificate on each phone

Hand `ca.crt` to each phone yourself. Email it from your own account to your own phone, or AirDrop it. Never send a link, and never use a copy someone else passed on.

**iPhone.**

1. Open the attachment in Mail or AirDrop. The phone says Profile Downloaded.
2. In Settings, tap Profile Downloaded. It says Not Verified. That is normal.
3. Before you install, tap More Details, then the certificate. Compare its SHA-256 fingerprint with the one you wrote down. Install only if they match.
4. Then go to Settings, General, About, Certificate Trust Settings. Turn on trust for the ShelfReady certificate authority.

**Android.** Use Chrome. A screen lock is required.

1. Save `ca.crt` to the phone.
2. Settings, Security, Encryption and credentials, Install a certificate, CA certificate. Menus differ by phone. Search Settings for "CA certificate".
3. Right after, open Trusted credentials, User, and check the fingerprint matches. If it does not, remove it.

### Test from the phones

- On shop Wi-Fi, open `https://shelfready.example.com:8443`. The padlock shows with no warning and the sign in page loads.
- On mobile data, with Wi-Fi off, the same address must not connect.

Never continue past a certificate warning. If one appears, stop and find out why.

### Renew once a year

The Settings page and `check.sh` warn 30 days before the certificate ends. To renew:

```
node scripts/net/private-cert.ts make shelfready.example.com replace
```

Then remove the old profile from each phone and install the new `ca.crt`. Check the new fingerprint. A new authority each year is the price of destroying its key.

### If the router blocks the name

Make the certificate for the name and the address together, and add the address to `allowedHosts`:

```
node scripts/net/private-cert.ts make shelfready.example.com 10.0.0.20 replace
```

Phones then open `https://10.0.0.20:8443`. Browsers do not apply HSTS to an address, so a certificate warning there can be clicked past. Never click past one.

### A public certificate

`scripts/net/cert.ts` can get a Let's Encrypt certificate with a DNS challenge, using acme.sh. `config/cert.example.json` lists its settings, and `node scripts/net/cert.ts preflight` checks them. It suits an install that phones reach by a real public name. It is optional and less tested than the private certificate.

## 5. Run it as a service

`scripts/net/service.sh` keeps ShelfReady running. It is built for a Linux PC with no systemd, and runs from the user's own crontab, with no root. Commands: `start`, `stop`, `restart`, `status`, `ensure`.

1. Run `scripts/net/service.sh crontab`. It prints the lines to use, with this PC's paths.
2. Run `crontab -e` and paste them at the end. One starts ShelfReady at boot. One starts it again within 5 minutes if it stops.

The server runs at low priority (`nice` 10, idle disk), so people using the PC come first. A supervisor starts it again if it stops. Logs are in `data/logs/`, rotated past 5 MB. No log holds a key or password.

If your system has systemd, you can run `node src/server/main.ts` from a user unit instead. That is not tested here. Keep it a normal user, and keep the same low priority.

If Node is upgraded, the crontab lines name Node's full path. Run `scripts/net/service.sh crontab` again and update them.

## 6. The git hooks

`npm run hooks` points git at `scripts/git-hooks`. The pre-commit hook checks exactly what you stage and stops the commit if:

- Store data is staged: the `reference`, `test-invoices`, `data` or `backups` folders, or any photo, PDF, office file, archive, database or other binary outside `test/fixtures/`.
- Something looks like a secret: an Anthropic key, a Square token, a Mailchimp key, a private key or a bearer header.
- The live Square host or the live read-only token is named outside the two files allowed to.
- Staged text matches a term in `~/.config/shelfready/store-terms.txt`. This is optional. Put one fixed string per line there, such as your store's name or a vendor's. The file stays outside the repo.
- The type check or the tests fail. They run on a copy of the staged files, so unfinished work elsewhere does not block the commit.

Do not skip the hook.
