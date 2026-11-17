#!/usr/bin/env bash
# ShelfReady dev harness for ScaleConnect: three fake scales on 127.0.0.1 and
# ScaleConnect's real MCP server on http://127.0.0.1:18765/mcp.
#
#   dev-sc.sh start [--timing real]   start in the background, wait until ready
#   dev-sc.sh stop                    stop the MCP server and the fakes
#   dev-sc.sh status                  show what is running
#   dev-sc.sh unplug NAME             a fake scale stops answering (FRONT, KITCHEN, COUNTER)
#   dev-sc.sh plug NAME               it answers again
#
# ScaleConnect in ~/CCScaleApp is only imported, never written. Everything the
# harness writes goes to data/dev-scaleconnect/, which git ignores.
#
# This script signals only a process whose command line is this project's
# harness.py run with this project's data folder. The live ScaleConnect server
# runs on this PC too, so a stale pid file must never be trusted on its own.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
DATA="$ROOT/data/dev-scaleconnect"
SC="${SCALECONNECT_HOME:-$HOME/CCScaleApp/ScaleConnect}"
PY="$SC/.venv/bin/python"
HARNESS="$HERE/harness.py"
LOG="$DATA/harness.log"
LOG_MAX_BYTES=1048576

export PYTHONPATH="$SC/src:$SC/tests"
export PYTHONDONTWRITEBYTECODE=1
export SCALECONNECT_CONFIG="$DATA/config.toml"
export SCALECONNECT_READ_LOG="$DATA/read-problems.log"

if [ ! -x "$PY" ]; then
  echo "ScaleConnect's venv python was not found at $PY" >&2
  exit 1
fi

ctl() { nice -n 19 "$PY" "$HARNESS" ctl "$@"; }

# True only if pid is this project's harness: "harness.py run --data <this data folder>".
is_our_harness() {
  local pid="$1" args
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  [ -r "/proc/$pid/cmdline" ] || return 1
  args="$(tr '\0' '\n' <"/proc/$pid/cmdline")" || return 1
  printf '%s\n' "$args" | grep -Fxq -- "$HARNESS" || return 1
  printf '%s\n' "$args" | grep -Fxq -- "run" || return 1
  printf '%s\n' "$args" | grep -Fxq -- "--data" || return 1
  printf '%s\n' "$args" | grep -Fxq -- "$DATA" || return 1
}

running_pid() {
  local pid
  [ -f "$DATA/harness.pid" ] || return 1
  pid="$(head -c 16 "$DATA/harness.pid" | tr -cd '0-9')"
  is_our_harness "$pid" || return 1
  echo "$pid"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  start)
    for part in "$ROOT/data" "$DATA"; do
      if [ -L "$part" ]; then
        echo "$part is a symlink. Refusing to start." >&2
        exit 1
      fi
    done
    mkdir -p "$DATA"
    chmod 700 "$DATA"
    # Only one start at a time. The harness also holds its own lock for its whole life.
    exec 9>"$DATA/start.lock"
    if ! flock -n 9; then
      echo "Another start is in progress." >&2
      exit 1
    fi
    if pid="$(running_pid)"; then
      echo "Already running (pid $pid)."
      exit 0
    fi
    if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt "$LOG_MAX_BYTES" ]; then
      mv -f "$LOG" "$LOG.1"
    fi
    touch "$LOG"
    chmod 600 "$LOG"
    nohup nice -n 19 "$PY" "$HARNESS" run --data "$DATA" "$@" >>"$LOG" 2>&1 </dev/null 9>&- &
    child=$!
    for _ in $(seq 1 120); do
      if [ -S "$DATA/control.sock" ] && ctl status >/dev/null 2>&1; then
        echo "Dev ScaleConnect is ready at http://127.0.0.1:18765/mcp"
        echo "Connection details (with the token, mode 600): $DATA/connection.json"
        exit 0
      fi
      if ! kill -0 "$child" 2>/dev/null; then
        echo "The harness stopped while starting. Last lines of $LOG:" >&2
        tail -n 20 "$LOG" >&2
        exit 1
      fi
      sleep 0.5
    done
    echo "The harness did not become ready in 60 seconds. See $LOG" >&2
    exit 1
    ;;
  stop)
    if ! pid="$(running_pid)"; then
      echo "Not running."
      exit 0
    fi
    if ! ctl stop >/dev/null 2>&1; then
      is_our_harness "$pid" && kill -TERM "$pid" 2>/dev/null || true
    fi
    for _ in $(seq 1 60); do
      is_our_harness "$pid" || { echo "Stopped."; exit 0; }
      sleep 0.5
    done
    if is_our_harness "$pid"; then
      echo "Still running after 30 seconds. Sending SIGKILL to harness pid $pid." >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
    ;;
  status)
    if ! running_pid >/dev/null; then
      echo "Not running."
      exit 3
    fi
    ctl status
    ;;
  unplug|plug)
    if [ $# -ne 1 ]; then
      echo "Usage: $0 $cmd NAME" >&2
      exit 2
    fi
    ctl "$cmd" "$1"
    ;;
  *)
    echo "Usage: $0 start [--timing real] | stop | status | unplug NAME | plug NAME" >&2
    exit 2
    ;;
esac
