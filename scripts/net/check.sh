#!/bin/sh
# Checks ShelfReady's HTTPS and network exposure from this PC, then lists what to test from a
# phone. Run it after the service starts: scripts/net/check.sh
#
# Reads config/local/server.json (or the file in SHELFREADY_CONFIG) through the server's own
# loader, so the defaults match. Uses curl, openssl and ss. Never shows a cookie value.
# Phase 1 (no config/local/cert.json): the private store certificate, trusted through the store
# CA in the certificate folder (ca.crt), on store Wi-Fi only. Phase 2: Let's Encrypt and Tailscale.
# Exit code 1 when a check fails.

set -u
REPO=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd -P)
NODE=${SHELFREADY_NODE:-$(command -v node || true)}
[ -n "$NODE" ] || {
  echo "node not found. Set SHELFREADY_NODE to its full path."
  exit 2
}
for tool in curl openssl ss; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool is needed for these checks."
    exit 2
  }
done
CERT_CONFIG=${SHELFREADY_CERT_CONFIG:-$REPO/config/local/cert.json}
if [ -f "$CERT_CONFIG" ]; then PHASE=2; else PHASE=1; fi

fails=0
ok() { echo "OK   $*"; }
warn() { echo "WARN $*"; }
fail() {
  fails=$((fails + 1))
  echo "FAIL $*"
}

# The settings, from the server's own config loader. Only safe characters come back.
info=$(SR_REPO="$REPO" "$NODE" --input-type=module -e '
  const { loadConfig } = await import(`file://${process.env.SR_REPO}/src/server/config.ts`);
  const { dirname } = await import("node:path");
  const c = loadConfig();
  const out = { tls: c.tls.enabled ? "on" : "off", port: c.port, host: c.host, addrs: c.listenAddresses.join(" "), names: c.allowedHosts.join(" "), tlsdir: dirname(c.tls.statusPath) };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
' 2>&1) || {
  echo "FAIL the server config could not be read:"
  echo "$info"
  exit 1
}
if printf '%s\n' "$info" | LC_ALL=C grep -q '[^A-Za-z0-9=.:/_ -]'; then
  echo "FAIL the server config gave unexpected characters."
  exit 1
fi
get() { printf '%s\n' "$info" | sed -n "s/^$1=//p"; }
TLS=$(get tls)
PORT=$(get port)
HOST=$(get host)
ADDRS=$(get addrs)
NAMES=$(get names)
CAFILE="$(get tlsdir)/ca.crt"
# Host names and bare addresses in allowedHosts, apart.
DNSNAMES=''
IPNAMES=''
for n in $NAMES; do
  case "$n" in *[!0-9.]*) DNSNAMES="$DNSNAMES $n" ;; *) IPNAMES="$IPNAMES $n" ;; esac
done
NAME=''
for n in $DNSNAMES; do [ -n "$NAME" ] || NAME=$n; done
LAN=''
for a in $ADDRS; do
  case "$a" in 100.* | *:*) ;; *) [ -n "$LAN" ] || LAN=$a ;; esac
done

echo "ShelfReady network check (Phase $PHASE), $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "Port $PORT. This PC: $HOST. Store network and tailnet: ${ADDRS:-none}. Names: ${NAMES:-none}."
echo

if [ "$TLS" != "on" ]; then
  fail "HTTPS is off in the server config. Turn it on as docs/INSTALL.md says."
  exit 1
fi
[ -n "$NAMES" ] || warn "allowedHosts is empty, so only this PC can use ShelfReady."

# 1. What the server listens on: only this PC's loopback and the listed addresses, only this port.
case "$HOST" in
  localhost) expect="127.0.0.1 [::1]" ;;
  ::1) expect="[::1]" ;;
  *) expect="$HOST" ;;
esac
for a in $ADDRS; do
  case "$a" in *:*) expect="$expect [$a]" ;; *) expect="$expect $a" ;; esac
done
# The server is the process that is ours (owned by this user) and runs this ShelfReady's
# main.ts. A pid from the pid file or from ss counts only if both hold: a reused pid does not.
is_server() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  [ -O "/proc/$1" ] || return 1
  cmd=$(tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null)
  case "$cmd" in *"$REPO/src/server/main.ts"*) return 0 ;; esac
  # Started by hand from the ShelfReady folder, with the short path.
  case "$cmd" in *" src/server/main.ts"*) [ "$(readlink "/proc/$1/cwd" 2>/dev/null)" = "$REPO" ] ;; *) return 1 ;; esac
}
pid=''
for p in $(cat "$REPO/data/run/server.pid" 2>/dev/null) $(ss -Htlnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\),.*/\1/p'); do
  if is_server "$p"; then
    pid=$p
    break
  fi
done
seen=''
[ -z "$pid" ] || seen=$(ss -Htlnp 2>/dev/null | grep "pid=$pid," | awk '{print $4}' | sed 's/%[^:]*:/:/')
# Any other program listening on this port, on any address, could be posing as ShelfReady. This
# runs first, so a program holding the port is named even when ShelfReady is not running.
for s in $(ss -Htln "sport = :$PORT" 2>/dev/null | awk '{print $4}' | sed 's/%[^:]*:/:/'); do
  echo "$seen" | grep -qxF "$s" || fail "another program listens on $s, ShelfReady's port. Find it with: ss -tlnp, as root if it is not yours."
done
if [ -z "$pid" ]; then
  fail "the ShelfReady server is not running on port $PORT. Start the service: scripts/net/service.sh start"
  exit 1
fi
for s in $seen; do
  addr=${s%:*}
  port=${s##*:}
  case "$addr" in
    0.0.0.0 | '[::]' | '*') fail "the server listens on $s: every network, the internet included." ;;
    *)
      if [ "$port" != "$PORT" ]; then
        fail "the server also listens on $s, which is not its port."
      elif echo " $expect " | grep -qF " $addr "; then
        ok "listening on $s"
      else
        fail "the server listens on $s, which is not in the config."
      fi
      ;;
  esac
done
for e in $expect; do
  echo "$seen" | grep -qxF "$e:$PORT" || warn "not listening on $e:$PORT yet. If that address is not up (Wi-Fi or Tailscale), the server keeps trying."
done

# 2. The certificate: chain and names, the way a phone sees them. The private store certificate
# is checked against the store CA in the certificate folder, as the phones that installed it do.
sni=${NAME:-${IPNAMES# }}
sni=${sni%% *}
pem=$(openssl s_client -connect "127.0.0.1:$PORT" ${NAME:+-servername "$NAME"} </dev/null 2>/dev/null | openssl x509 2>/dev/null)
certinfo=$(printf '%s\n' "$pem" | openssl x509 -noout -issuer -enddate -ext subjectAltName 2>/dev/null)
if [ -z "$certinfo" ]; then
  fail "no certificate came back from 127.0.0.1:$PORT."
else
  echo "$certinfo" | sed 's/^/     /'
fi
staging=0
private=0
echo "$certinfo" | grep -q '(STAGING)' && staging=1
echo "$certinfo" | grep -q 'O=ShelfReady private store CA' && private=1
trust=''
if [ "$private" -eq 1 ]; then
  if [ -f "$CAFILE" ]; then
    trust="--cacert $CAFILE"
    ok "this is the private store certificate; checking it against the store CA in $CAFILE"
  else
    fail "this is the private store certificate, but there is no store CA at $CAFILE to check it with."
  fi
fi
[ "$staging" -eq 1 ] && warn "this is a test certificate from Let's Encrypt staging. Phones will not trust it until the real one is issued."
# How long it has left. The private store certificate is made by hand once a year, so it warns a
# month ahead; a Let's Encrypt one renews itself 30 days ahead, so it warns at 14 days.
ends_within() { printf '%s\n' "$pem" | openssl x509 -noout -checkend "$1" >/dev/null 2>&1 && return 1 || return 0; }
if [ -n "$pem" ]; then
  if ends_within 0; then
    fail "the certificate has run out. Phones refuse ShelfReady until it is replaced."
  elif [ "$private" -eq 1 ] && ends_within 2592000; then
    warn "the private store certificate ends within 30 days. Make a new one and install its store CA on both phones (docs/INSTALL.md, Phase 1, step 10)."
  elif [ "$private" -eq 0 ] && ends_within 1209600; then
    warn "the certificate ends within 14 days and has not been renewed. See docs/INSTALL.md."
  fi
fi
try_url() {
  # $1 label, $2 url, then curl words (--resolve). Prints OK when the page loads over a trusted certificate.
  label=$1
  url=$2
  shift 2
  # shellcheck disable=SC2086
  res=$(curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}' --max-time 10 $trust "$@" "$url" 2>/dev/null)
  case "$res" in
    "200 0") ok "$label: trusted certificate, sign-in page loads" ;;
    *)
      if [ "$staging" -eq 1 ]; then
        warn "$label is not trusted (expected with a test certificate)"
      else
        fail "$label did not load with a trusted certificate (got: ${res:-no answer})"
      fi
      ;;
  esac
}
for n in $DNSNAMES; do
  for a in 127.0.0.1 $ADDRS; do
    case "$a" in *:*) r="[$a]" ;; *) r="$a" ;; esac
    try_url "https://$n:$PORT through $a" "https://$n:$PORT/login" --resolve "$n:$PORT:$r"
  done
done
for ip in $IPNAMES; do
  try_url "https://$ip:$PORT" "https://$ip:$PORT/login"
done

# 3. TLS versions: 1.2 and 1.3 only.
sni=${sni:-localhost}
if timeout 10 openssl s_client -connect "127.0.0.1:$PORT" -servername "$sni" -tls1_1 -cipher 'DEFAULT:@SECLEVEL=0' </dev/null >/dev/null 2>&1; then
  fail "TLS 1.1 was accepted."
else
  ok "TLS 1.1 is refused"
fi
for v in tls1_2 tls1_3; do
  if timeout 10 openssl s_client -connect "127.0.0.1:$PORT" -servername "$sni" "-$v" </dev/null >/dev/null 2>&1; then ok "$v works"; else fail "$v does not work."; fi
done

# 4. Other names are refused (DNS rebinding), and plain http gets nothing. A bare address is
# answered only when allowedHosts lists it (Phase 1).
code=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "wrong-name.invalid:$PORT:127.0.0.1" "https://wrong-name.invalid:$PORT/login" 2>/dev/null)
[ "$code" = "421" ] && ok "a request for another name is refused (421)" || fail "a request for another name got $code, not 421."
for a in $ADDRS; do
  case "$a" in *:*) r="[$a]" ;; *) r="$a" ;; esac
  code=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$r:$PORT/login" 2>/dev/null)
  if echo " $IPNAMES " | grep -qF " $a "; then
    [ "$code" = "200" ] && ok "a request to $a by its address is answered (allowedHosts lists it)" || fail "a request to $a by its address got ${code:-no answer}, not 200."
  else
    [ "$code" = "421" ] && ok "a request to $a by its address is refused (421)" || warn "a request to $a by its address got ${code:-no answer}, not 421."
  fi
  code=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "localhost:$PORT:$r" "https://localhost:$PORT/login" 2>/dev/null)
  [ "$code" = "421" ] && ok "localhost is refused on $a (421)" || warn "localhost on $a got ${code:-no answer}, not 421."
done
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/login" 2>/dev/null)
case "$code" in 2* | 3*) fail "plain http on port $PORT answered $code." ;; *) ok "plain http on port $PORT gets no page" ;; esac

# 5. HSTS and Secure cookies. HSTS for the host name, never for a bare address.
headers_for() {
  # -k: trust was checked above. Here only the headers matter.
  curl -k -sS -D - -o /dev/null --max-time 10 "$@" 2>/dev/null | tr -d '\r'
}
if [ -n "$NAME" ]; then
  headers=$(headers_for --resolve "$NAME:$PORT:127.0.0.1" "https://$NAME:$PORT/login")
  hsts=$(printf '%s\n' "$headers" | grep -i '^strict-transport-security:' | head -n 1)
  [ -n "$hsts" ] && ok "HSTS is sent for $NAME: ${hsts#*: }" || fail "no HSTS header on https://$NAME:$PORT."
else
  headers=''
fi
for ip in $IPNAMES; do
  h=$(headers_for "https://$ip:$PORT/login")
  [ -n "$headers" ] || headers=$h
  printf '%s\n' "$h" | grep -qi '^strict-transport-security:' && fail "HSTS is sent for the bare address $ip." || ok "no HSTS for the bare address $ip"
done
cookies=$(printf '%s\n' "$headers" | grep -i '^set-cookie:')
if [ -z "$cookies" ]; then
  warn "no cookie was set on the sign-in page, so cookie flags were not checked."
elif printf '%s\n' "$cookies" | grep -iv '; secure' | grep -q .; then
  fail "a cookie is sent without the Secure flag."
elif printf '%s\n' "$cookies" | grep -v '^[Ss]et-[Cc]ookie: __Host-' | grep -q .; then
  fail "a cookie lacks the __Host- prefix."
else
  ok "cookies carry Secure and the __Host- prefix"
fi

# 6. DNS for the host name, and in Phase 2, Tailscale.
if [ -n "$NAME" ]; then
  here=$(getent ahostsv4 "$NAME" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
  match=0
  for a in $here; do echo " $ADDRS " | grep -qF " $a " && match=1; done
  if [ "$match" -eq 1 ]; then
    ok "$NAME looks up to $here"
  elif [ -n "$IPNAMES" ]; then
    warn "$NAME does not look up to ${LAN:-a listening address} on this PC (${here:-no answer}). The phones use the address fallback."
  else
    # The phones use the name, and they ask the same DNS as this PC.
    fail "$NAME does not look up to ${LAN:-a listening address} on this PC (${here:-no answer}), so phones cannot use it. Add the DNS record (docs/INSTALL.md, Phase 1, step 3)."
  fi
fi
if [ "$PHASE" -eq 2 ] && command -v tailscale >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && [ -n "$LAN" ]; then
  routes=$(tailscale status --self --json 2>/dev/null | jq -r '.Self.PrimaryRoutes // [] | .[]' 2>/dev/null | tr '\n' ' ')
  if echo " $routes " | grep -qF " $LAN/32 "; then ok "Tailscale serves the route $LAN/32"; else warn "Tailscale does not serve $LAN/32 yet: advertise it and approve it (docs/INSTALL.md)."; fi
fi

echo
if [ "$fails" -eq 0 ]; then echo "All checks from this PC passed."; else echo "$fails check(s) failed."; fi
echo
if [ "$PHASE" -eq 1 ]; then
  if [ -n "$NAME" ]; then url="https://$NAME:$PORT"; else url="https://${LAN:-the store address}:$PORT"; fi
  echo "Now test from the phones (docs/INSTALL.md, Phase 1), the iPhone first:"
  echo "  1. Each of the two phones on store Wi-Fi: open $url and see the padlock and the sign-in page."
  echo "  2. The same phone on mobile data, Wi-Fi off: the same address must not connect at all."
  echo "  3. Any other device on store Wi-Fi (with the per-phone firewall rules): it must not connect either."
  echo "  Never continue past a certificate warning. If one appears, stop and tell Bart."
else
  echo "Now test from phones (docs/INSTALL.md, Phase 2):"
  echo "  1. A phone on store Wi-Fi, Tailscale off: open https://${NAME:-NAME}:$PORT and see the padlock and the sign-in page."
  echo "  2. Bart's phone away from the store, on mobile data, Tailscale on: the same address works."
  echo "  3. The same phone, Tailscale on: http://${LAN:-the store address}:8765 (ScaleConnect) must not load."
  echo "  4. A phone on mobile data, Tailscale off: the ShelfReady address must not connect at all."
fi
[ "$fails" -eq 0 ]
