#!/bin/sh
# ShelfReady as a service on the store PC (Debian with sysvinit, no systemd), run from Bart's own
# crontab, as Bart. No root needed. Print the crontab lines with: scripts/net/service.sh crontab
#
#   service.sh start          start in the background (the @reboot line)
#   service.sh ensure         start if not running, and rotate big logs (every 5 minutes)
#   service.sh stop | restart | status
#   service.sh reload         load a renewed certificate now (the server also looks each minute)
#   service.sh renew-cert     the daily certificate check (cron)
#   service.sh test-renewal   the monthly renewal test against Let's Encrypt staging (cron)
#   service.sh crontab        print the crontab lines with this PC's paths
#
# The server runs under nice 10 with idle disk priority, so staff on this PC come first. If it
# stops, the supervisor starts it again, waiting longer after each quick failure, up to 5 minutes.
# Logs in data/logs: server.log (the server), service.log (this script), cert.log (renewals).
# Each is rotated past 5 MB, keeping 5 old copies.

set -u
umask 077

die() {
  echo "service.sh: $*" >&2
  exit 1
}
[ "$(id -u)" -ne 0 ] || die "do not run this as root. Run it as the user who owns the ShelfReady folder."

SELF=$(readlink -f "$0")
REPO=$(cd "$(dirname "$SELF")/../.." && pwd -P)
RUN="$REPO/data/run"
LOGS="$REPO/data/logs"
MAX_LOG_BYTES=5242880
KEEP_LOGS=5
# Phase 2 only: the Let's Encrypt install config. Without it there is nothing to renew (Phase 1
# uses the private store certificate, made by hand).
CERT_CONFIG=${SHELFREADY_CERT_CONFIG:-$REPO/config/local/cert.json}

# The run and log folders, made when a command needs them (not for printing the crontab).
prepare_dirs() {
  mkdir -p "$RUN" "$LOGS" || die "cannot make $RUN and $LOGS"
  chmod 700 "$RUN" "$LOGS"
}

note() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" >>"$LOGS/service.log"; }

find_node() {
  NODE=${SHELFREADY_NODE:-$(command -v node || true)}
  [ -n "$NODE" ] && [ -x "$NODE" ] || die "node not found. Set SHELFREADY_NODE to its full path (see: service.sh crontab)."
}

# The pid in a file, but only while that process is still the one meant: it must belong to this
# user and run the expected command. A reused pid, or anyone else's process, is ignored.
pid_of() {
  [ -f "$1" ] || return 1
  p=$(cat "$1" 2>/dev/null) || return 1
  case "$p" in '' | *[!0-9]*) return 1 ;; esac
  [ -O "/proc/$p" ] || return 1
  tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -qF -- "$2" || return 1
  echo "$p"
}
supervisor_pid() { pid_of "$RUN/supervisor.pid" "$SELF run"; }
server_pid() { pid_of "$RUN/server.pid" "$REPO/src/server/main.ts"; }
# Whether a supervisor is alive is decided by its lock, which only a living supervisor holds.
supervisor_running() { ! flock -n "$RUN/supervisor.lock" true 2>/dev/null; }

rotate() {
  f=$1
  [ -f "$f" ] || return 0
  [ "$(wc -c <"$f")" -gt "$MAX_LOG_BYTES" ] || return 0
  i=$KEEP_LOGS
  rm -f "$f.$i"
  while [ "$i" -gt 1 ]; do
    j=$((i - 1))
    [ -f "$f.$j" ] && mv -f "$f.$j" "$f.$i"
    i=$j
  done
  # Copy, then empty: the server keeps writing to the same open file.
  cp -p "$f" "$f.1" && : >"$f"
}

rotate_all() {
  (
    flock -n 8 || exit 0
    for f in server.log service.log cert.log; do rotate "$LOGS/$f"; done
  ) 8>"$RUN/rotate.lock"
}

# The supervisor. One at a time: it holds a lock for its whole life. The server does not get the
# lock (9>&-), so the lock always means a living supervisor.
run_loop() {
  exec 9>"$RUN/supervisor.lock"
  flock -n 9 || exit 0
  echo $$ >"$RUN/supervisor.pid"
  find_node
  stopping=0
  child=''
  pause=''
  trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null; [ -n "$pause" ] && kill "$pause" 2>/dev/null' TERM INT
  trap '[ -n "$child" ] && kill -HUP "$child" 2>/dev/null' HUP
  delay=2
  note "supervisor started (pid $$)"
  cd "$REPO" || exit 1
  while [ "$stopping" -eq 0 ]; do
    started=$(date +%s)
    if command -v ionice >/dev/null 2>&1; then
      nice -n 10 ionice -c 3 "$NODE" "$REPO/src/server/main.ts" </dev/null >>"$LOGS/server.log" 2>&1 9>&- &
    else
      nice -n 10 "$NODE" "$REPO/src/server/main.ts" </dev/null >>"$LOGS/server.log" 2>&1 9>&- &
    fi
    child=$!
    # A stop that came while the server was being started must reach it too.
    [ "$stopping" -eq 0 ] || kill -TERM "$child" 2>/dev/null
    echo "$child" >"$RUN/server.pid"
    note "server started (pid $child)"
    wait "$child"
    code=$?
    # A signal ends the wait early. Wait again until the server has really finished.
    while kill -0 "$child" 2>/dev/null; do
      wait "$child"
      code=$?
    done
    child=''
    rm -f "$RUN/server.pid"
    [ "$stopping" -eq 0 ] || break
    ran=$(($(date +%s) - started))
    [ "$ran" -lt 300 ] || delay=2
    note "server stopped (exit $code) after ${ran}s; starting it again in ${delay}s"
    sleep "$delay" 9>&- &
    pause=$!
    # A stop that came just before the pause began ends it too.
    [ "$stopping" -eq 0 ] || kill "$pause" 2>/dev/null
    wait "$pause"
    pause=''
    delay=$((delay * 2))
    [ "$delay" -le 300 ] || delay=300
  done
  note "supervisor stopped"
  rm -f "$RUN/supervisor.pid"
}

start() {
  if supervisor_running; then
    echo "ShelfReady is already running."
    return 0
  fi
  if server_pid >/dev/null; then
    echo "A ShelfReady server is already running without its supervisor. Run: $SELF restart"
    return 1
  fi
  find_node
  rotate_all
  setsid /bin/sh "$SELF" run </dev/null >>"$LOGS/service.log" 2>&1 &
  i=0
  while [ "$i" -lt 50 ] && ! supervisor_pid >/dev/null; do
    sleep 0.1
    i=$((i + 1))
  done
  if supervisor_pid >/dev/null; then
    echo "ShelfReady started. Logs are in $LOGS."
  else
    echo "ShelfReady did not start. See $LOGS/service.log."
    return 1
  fi
}

wait_gone() {
  i=0
  while [ "$i" -lt "$2" ] && kill -0 "$1" 2>/dev/null; do
    sleep 0.1
    i=$((i + 1))
  done
  ! kill -0 "$1" 2>/dev/null
}

stop() {
  if supervisor_running && ! supervisor_pid >/dev/null; then
    die "a supervisor holds the lock, but its pid file is missing or wrong. Find it with: pgrep -u $(id -u) -f 'service.sh run'"
  fi
  if p=$(supervisor_pid); then
    kill -TERM "$p"
    if ! wait_gone "$p" 300; then
      s=$(server_pid) && kill -KILL "$s"
      kill -KILL "$p" 2>/dev/null
      note "stop: had to kill the server after 30 seconds"
    fi
    echo "ShelfReady stopped."
  elif s=$(server_pid); then
    kill -TERM "$s"
    wait_gone "$s" 300 || kill -KILL "$s"
    rm -f "$RUN/server.pid"
    echo "ShelfReady stopped (it was running without its supervisor)."
  else
    echo "ShelfReady is not running."
  fi
}

status() {
  if supervisor_running; then echo "Supervisor running (pid $(supervisor_pid || echo unknown))."; else echo "Supervisor not running."; fi
  if s=$(server_pid); then
    echo "Server running (pid $s). It listens on:"
    ss -Htlnp 2>/dev/null | grep "pid=$s," | awk '{print "  " $4}'
  else
    echo "Server not running."
  fi
  if [ -f "$LOGS/service.log" ]; then
    echo "Last lines of $LOGS/service.log:"
    tail -n 5 "$LOGS/service.log" | sed 's/^/  /'
  fi
}

# Certificate jobs for cron. One at a time (a kernel lock, on top of cert.ts's own). Output goes
# to cert.log, stamped, and only when there is some.
cert_job() {
  find_node
  if [ ! -f "$CERT_CONFIG" ]; then
    note "certificate job skipped: no $CERT_CONFIG (Phase 1 uses the private store certificate)"
    return 0
  fi
  exec 7>"$RUN/cert-job.lock"
  if ! flock -n 7; then
    note "certificate job skipped: another one is still running"
    return 0
  fi
  out=$(cd "$REPO" && nice -n 19 "$NODE" scripts/net/cert.ts "$@" 2>&1 7>&-)
  code=$?
  if [ -n "$out" ]; then
    {
      echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') cert.ts $* (exit $code)"
      echo "$out"
    } >>"$LOGS/cert.log"
  fi
  return "$code"
}

# The renewal lines only when there is a Let's Encrypt config (Phase 2).
print_crontab() {
  find_node
  q() { printf "'%s'" "$1"; }
  if [ -f "$CERT_CONFIG" ]; then
    echo "# ShelfReady: start at boot, start again if stopped, renew the certificate. See docs/INSTALL.md."
  else
    echo "# ShelfReady: start at boot, start again if stopped. See docs/INSTALL.md, Phase 1."
  fi
  echo "@reboot SHELFREADY_NODE=$(q "$NODE") $(q "$SELF") start"
  echo "*/5 * * * * SHELFREADY_NODE=$(q "$NODE") $(q "$SELF") ensure"
  if [ -f "$CERT_CONFIG" ]; then
    echo "17 3 * * * SHELFREADY_NODE=$(q "$NODE") $(q "$SELF") renew-cert"
    echo "47 3 1 * * SHELFREADY_NODE=$(q "$NODE") $(q "$SELF") test-renewal"
  fi
}

case "${1:-}" in
  crontab | '') ;;
  *) prepare_dirs ;;
esac

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status) status ;;
  ensure)
    rotate_all
    if ! supervisor_running && ! server_pid >/dev/null; then
      note "ensure: not running, starting"
      start >/dev/null
    fi
    ;;
  reload)
    if s=$(server_pid); then
      kill -HUP "$s" && echo "Asked the server to load the certificate files again."
    else
      die "the server is not running."
    fi
    ;;
  renew-cert) cert_job renew quiet ;;
  test-renewal) cert_job renew dry-run ;;
  crontab) print_crontab ;;
  run) run_loop ;;
  *)
    echo "Usage: $0 start|stop|restart|status|ensure|reload|renew-cert|test-renewal|crontab" >&2
    exit 2
    ;;
esac
