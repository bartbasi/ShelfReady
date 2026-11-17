"""ShelfReady development harness for ScaleConnect.

Starts three fake scales on 127.0.0.1, writes a dev ScaleConnect config and a
seeded catalog under data/dev-scaleconnect/, and runs ScaleConnect's real MCP
server against them over Streamable HTTP. Nothing here reaches a real scale or
the live ScaleConnect server.

Run it through dev-sc.sh. It must run with ScaleConnect's venv python, with
PYTHONPATH set to ScaleConnect's src and tests folders. Those folders are only
imported, never written: PYTHONDONTWRITEBYTECODE must be set too.

    harness.py run --data DATA_DIR [--timing fast|real]   the harness itself, in the foreground
    harness.py ctl status|stop|unplug NAME|plug NAME

The control channel is a Unix socket in the data folder, mode 600.
"""

from __future__ import annotations

import argparse
import ctypes
import fcntl
import json
import os
import secrets
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HARNESS_FILE = Path(__file__).resolve()
ROOT = HARNESS_FILE.parents[2]
DATA = ROOT / "data" / "dev-scaleconnect"
CONFIG = DATA / "config.toml"
CONNECTION = DATA / "connection.json"
CONTROL = DATA / "control.sock"
PIDFILE = DATA / "harness.pid"
LOCKFILE = DATA / "harness.lock"
SEED = DATA / "seed.json"
MCP_LOG = DATA / "mcp-server.log"

HOST = "127.0.0.1"
MCP_PORT = 18765
WEB_PORT = 18080  # written to the config only. The web page is never started here.
SCALE_NAMES = ("FRONT", "KITCHEN", "COUNTER")  # production names, in send order
SCALE_PORTS = (15036, 15037, 15038)
TIMESTAMP = "2026-11-01 08:00:00"

# Made up, but shaped like the store's items: 4 digit PLU equal to Code, sold by weight. Ids 1 to N
# with no gap. The store's real PLUs run from 1001 to 7262, so every dev PLU is in the 8000s and
# cannot be mistaken for a store item. The second digit keeps the store's groups: 81xx imported
# meats, 82xx salami, 87xx cheese. 8999 is a sentinel that only this harness seeds: tests check
# for it before any preview, to be sure they are talking to the dev server.
SENTINEL = ("8999", "SHELFREADY DEV HARNESS ONLY", "1.00")
SEED_ITEMS = (
    ("8112", "Prosciutto di Parma", "29.99"),
    ("8115", "Jamon Serrano", "27.99"),
    ("8121", "Speck Alto Adige", "26.99"),
    ("8203", "Genoa Salami", "12.99"),
    ("8207", "Finocchiona", "18.99"),
    ("8211", "Soppressata Calabrese", "16.99"),
    ("8704", "Comte 18 Month", "24.99"),
    ("8710", "Manchego 6 Month", "19.99"),
    ("8715", "Gruyere Reserve", "22.99"),
    ("8722", "Aged Gouda", "18.99"),
    ("8731", "Parmigiano Reggiano", "21.99"),
    ("8740", "Stilton", "23.99"),
    SENTINEL,
)


def log(text: str) -> None:
    print(f"[dev-scaleconnect {time.strftime('%H:%M:%S')}] {text}", flush=True)


def write_private(path: Path, text: str) -> None:
    """Create or replace a file that only this user can read."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def cmdline(pid: int) -> list[str]:
    """A process's arguments, or [] if it is gone or unreadable."""
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return []
    return [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]


def is_our_mcp(pid: int) -> bool:
    """True only for the MCP server this harness started, on the dev config. Never the live one."""
    args = cmdline(pid)
    return "scaleconnect.mcp_server" in args and "--config" in args and str(CONFIG) in args


def check_data_path() -> None:
    """Refuse to delete anything unless data/dev-scaleconnect is a real folder inside the project."""
    path = ROOT
    for part in ("data", "dev-scaleconnect"):
        path = path / part
        if path.is_symlink():
            raise RuntimeError(f"{path} is a symlink. Refusing to start.")
        if path.exists() and not path.is_dir():
            raise RuntimeError(f"{path} is not a folder. Refusing to start.")
        path.mkdir(mode=0o700, exist_ok=True)
        if path.is_symlink():
            raise RuntimeError(f"{path} is a symlink. Refusing to start.")
    if not DATA.resolve().is_relative_to(ROOT.resolve()) or DATA.resolve() != DATA:
        raise RuntimeError(f"{DATA} does not resolve to a folder inside {ROOT}. Refusing to start.")


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        # SO_REUSEADDR as the fakes and uvicorn use it: only a live listener makes the bind fail,
        # not connections from a just stopped run waiting out TIME_WAIT.
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST, port))
        except OSError:
            return False
    return True


def mcp_list_scales(token: str) -> dict:
    """One authenticated MCP session: initialize, then scale_list_scales. Returns its structured result.
    Contacts no scale. Raises on any failure. Messages never include the token."""
    url = f"http://{HOST}:{MCP_PORT}/mcp"
    base = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }

    def post(body: dict, extra: dict) -> tuple[dict, list[dict]]:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={**base, **extra}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            text = resp.read().decode("utf-8", "replace")
        if headers.get("content-type", "").startswith("application/json"):
            return headers, [json.loads(text)] if text.strip() else []
        msgs = [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:") and line[5:].strip()]
        return headers, msgs

    init = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "shelfready-dev-harness", "version": "0"}},
    }
    headers, msgs = post(init, {})
    session = headers.get("mcp-session-id")
    result = next((m["result"] for m in msgs if m.get("id") == 1 and "result" in m), None)
    if not session or result is None:
        raise RuntimeError("the MCP server did not complete initialize")
    extra = {"Mcp-Session-Id": session, "MCP-Protocol-Version": result.get("protocolVersion", "2025-06-18")}
    try:
        post({"jsonrpc": "2.0", "method": "notifications/initialized"}, extra)
        _, msgs = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                        "params": {"name": "scale_list_scales", "arguments": {}}}, extra)
        reply = next((m.get("result") for m in msgs if m.get("id") == 2), None)
        if not reply or reply.get("isError") or not isinstance(reply.get("structuredContent"), dict):
            raise RuntimeError("scale_list_scales did not answer cleanly")
        return reply["structuredContent"]
    finally:
        try:
            req = urllib.request.Request(url, headers={**base, **extra}, method="DELETE")
            urllib.request.urlopen(req, timeout=5).close()
        except (OSError, urllib.error.HTTPError):
            pass


# ---------------------------------------------------------------- the harness


def seed_items():
    from scaleconnect.models import Item

    return [
        Item(i, plu, plu, desc, price, field6=" ", fields_7_12=("1", "1", "0", "0", "0", "0"), timestamp=TIMESTAMP)
        for i, (plu, desc, price) in enumerate(SEED_ITEMS, start=1)
    ]


def config_text(token: str, fakes: dict, timing: str) -> str:
    def q(p: Path) -> str:
        return json.dumps(str(p))  # TOML basic strings accept JSON string escapes

    lines = [
        "# ShelfReady dev ScaleConnect config. Written by scripts/dev-scaleconnect/harness.py on each start.",
        "# Fake scales on 127.0.0.1 only. Holds a dev token: never commit, never copy elsewhere.",
        "",
        "[settings]",
    ]
    if timing == "fast":
        # The fakes answer at once and have no busy gap after a write, so short waits are enough.
        lines += [
            "reply_timeout_seconds = 5",
            "connect_timeout_seconds = 2",
            "connect_attempts = 2",
            "connect_retry_wait_seconds = 1",
            "read_pace_seconds = 0.01",
            "read_back_window_seconds = 15",
            "read_back_retry_seconds = 0.5",
        ]
    lines += [
        f"state_dir = {q(DATA / 'state')}",
        f"catalog_path = {q(DATA / 'catalog.sqlite3')}",
        f"backup_dir = {q(DATA / 'backups')}",
        f"read_problem_log = {q(DATA / 'read-problems.log')}",
        'scalelink_db_copy = "not_available_here"',
        "",
        "[auth]",
        f"mcp_token = {json.dumps(token)}",
        'mcp_caller = "shelfready-dev"',
        "",
        "[web]",
        f'host = "{HOST}"',
        f"port = {WEB_PORT}",
        "",
        "[mcp]",
        f'host = "{HOST}"',
        f"port = {MCP_PORT}",
    ]
    for name, fake in fakes.items():
        lines += [
            "",
            "[[scales]]",
            f'name = "{name}"',
            f'address = "{HOST}"',
            f"port = {fake.port}",
            f'serial = "{fake.serial}"',
            "write_enabled = true",
            "read_enabled = true",
        ]
    return "\n".join(lines) + "\n"


def child_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["SCALECONNECT_CONFIG"] = str(CONFIG)
    env["SCALECONNECT_READ_LOG"] = str(DATA / "read-problems.log")
    env["XDG_STATE_HOME"] = str(DATA / "xdg-state")
    return env


try:  # loaded here, in the parent. The forked child only calls prctl, which is safe with threads running.
    _PRCTL = ctypes.CDLL("libc.so.6", use_errno=True).prctl
except OSError:
    _PRCTL = None
_PARENT_PID = os.getpid()


def _die_with_parent() -> None:
    """Linux: the MCP server gets SIGTERM if the harness dies, even by SIGKILL."""
    if _PRCTL is not None:
        _PRCTL(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    if os.getppid() != _PARENT_PID:
        os._exit(1)  # the harness died before prctl took effect


class Harness:
    def __init__(self, timing: str):
        self.timing = timing
        self.fakes: dict = {}
        self.plugged: dict[str, bool] = {}
        self.mcp: subprocess.Popen | None = None
        self.mcp_log = None
        self.done = threading.Event()
        self.control: socketserver.UnixStreamServer | None = None
        self.lock = threading.Lock()
        self.lock_fd: int | None = None

    # ---- start

    def take_lock(self) -> bool:
        """One harness per data folder, held for its whole life. Two starts cannot race."""
        fd = os.open(LOCKFILE, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            return False
        self.lock_fd = fd
        return True

    def clean_data(self) -> None:
        check_data_path()
        os.chmod(DATA, 0o700)
        for name in ("state", "backups", "xdg-state"):
            if (DATA / name).is_symlink():
                raise RuntimeError(f"{DATA / name} is a symlink. Refusing to start.")
        for name in ("state", "backups", "xdg-state"):
            if (DATA / name).exists():
                shutil.rmtree(DATA / name)  # errors stop the start rather than leave old state behind
        for p in DATA.glob("catalog.sqlite3*"):
            p.unlink()
        for p in (CONFIG, CONNECTION, SEED, MCP_LOG, DATA / "read-problems.log", CONTROL):
            p.unlink(missing_ok=True)

    def start_fakes(self) -> None:
        from fake_scale import FakeScale

        if self.timing == "real":
            opts = dict(timing_factor=1.0, beat_stall_seconds=1.8, post_write_refusal_seconds=10.5)
        else:
            opts = dict(timing_factor=0.0, post_write_refusal_seconds=0.0)
        records = [tuple(item.to_fields()) for item in seed_items()]
        for name, port in zip(SCALE_NAMES, SCALE_PORTS):
            fake = FakeScale(port=port, serial=f"DEV-{name}", queue_sessions=True, **opts)
            fake.preload(*records)
            fake.start()
            self.fakes[name] = fake
            self.plugged[name] = True
            log(f"fake scale {name} on {HOST}:{fake.port}, serial {fake.serial}, {len(records)} items")

    def write_config_and_seed(self) -> str:
        from scaleconnect.seed import seed_catalog

        token = secrets.token_urlsafe(32)
        write_private(CONFIG, config_text(token, self.fakes, self.timing))
        write_private(SEED, json.dumps({"items": [i.to_dict() for i in seed_items()]}, indent=1))
        info = seed_catalog(None, SEED, believed_on=SCALE_NAMES, config_path=CONFIG)
        log(f"seeded {info['items']} items into {info['path']}")
        return token

    def start_mcp(self, token: str) -> None:
        venv_python = Path(sys.executable)
        fd = os.open(MCP_LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        self.mcp_log = os.fdopen(fd, "ab")
        self.mcp = subprocess.Popen(
            [str(venv_python), "-m", "scaleconnect.mcp_server", "--http", "--config", str(CONFIG)],
            env=child_env(),
            stdin=subprocess.DEVNULL,
            stdout=self.mcp_log,
            stderr=subprocess.STDOUT,
            preexec_fn=_die_with_parent,
        )
        # Ready means an authenticated MCP call with this start's token answers with our scales.
        deadline = time.monotonic() + 60
        last = "no answer yet"
        while time.monotonic() < deadline:
            if self.mcp.poll() is not None:
                raise RuntimeError(f"the MCP server exited with code {self.mcp.returncode}. See {MCP_LOG}")
            try:
                listed = mcp_list_scales(token)
                names = tuple(s.get("name") for s in listed.get("scales", []))
                if names != SCALE_NAMES:
                    raise RuntimeError(f"the MCP server lists scales {names}, not {SCALE_NAMES}")
                log(f"MCP server pid {self.mcp.pid} at http://{HOST}:{MCP_PORT}/mcp answered scale_list_scales")
                return
            except (OSError, ValueError, urllib.error.HTTPError) as exc:
                last = type(exc).__name__
                time.sleep(0.25)
        raise RuntimeError(f"the MCP server did not answer an authenticated call within 60 seconds ({last}). See {MCP_LOG}")

    def write_connection(self, token: str) -> None:
        info = {
            "url": f"http://{HOST}:{MCP_PORT}/mcp",
            "token": token,
            "config": str(CONFIG),
            "scales": {n: {"port": f.port, "serial": f.serial} for n, f in self.fakes.items()},
            "timing": self.timing,
            "harness_pid": os.getpid(),
        }
        write_private(CONNECTION, json.dumps(info, indent=1) + "\n")

    # ---- control

    def status(self) -> dict:
        with self.lock:
            scales = {
                name: {
                    "port": fake.port,
                    "serial": fake.serial,
                    "plugged": self.plugged[name],
                    "items": len(fake.items),
                    "protocol_violations": len(fake.unexpected_violations()),
                    # Messages the fake has received: LP starts a read of the table, GP writes one
                    # record. Tests count reads and writes of a scale with these.
                    "lp_messages": len(fake.messages_of("LP")),
                    "gp_messages": len(fake.messages_of("GP")),
                }
                for name, fake in self.fakes.items()
            }
        mcp_running = self.mcp is not None and self.mcp.poll() is None
        return {
            "ok": True,
            "harness_pid": os.getpid(),
            "timing": self.timing,
            "mcp": {"url": f"http://{HOST}:{MCP_PORT}/mcp", "pid": self.mcp.pid if self.mcp else None, "running": mcp_running},
            "scales": scales,
        }

    def set_plugged(self, name: str, plugged: bool) -> dict:
        name = name.upper()
        if name not in self.fakes:
            return {"ok": False, "error": f"no scale named {name}. Names: {', '.join(self.fakes)}"}
        with self.lock:
            fake = self.fakes[name]
            if plugged and not self.plugged[name]:
                fake.start_listening()
            elif not plugged and self.plugged[name]:
                # New connections are refused at once. A session already open is left to finish.
                fake.stop_listening()
            self.plugged[name] = plugged
        log(f"{name} {'plugged in' if plugged else 'unplugged'}")
        return {"ok": True, "scale": name, "plugged": plugged}

    def handle(self, line: str) -> dict:
        parts = line.split()
        if not parts:
            return {"ok": False, "error": "empty command"}
        cmd, args = parts[0].lower(), parts[1:]
        if cmd == "status":
            return self.status()
        if cmd == "stop":
            self.done.set()
            return {"ok": True, "stopping": True}
        if cmd in ("unplug", "plug") and len(args) == 1:
            return self.set_plugged(args[0], cmd == "plug")
        return {"ok": False, "error": "commands: status, stop, unplug NAME, plug NAME"}

    def start_control(self) -> None:
        harness = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                line = self.rfile.readline(512).decode("ascii", "replace").strip()
                try:
                    reply = harness.handle(line)
                except Exception as exc:  # a control error must not stop the harness
                    reply = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
                self.wfile.write((json.dumps(reply) + "\n").encode())

        old = os.umask(0o177)
        try:
            self.control = socketserver.UnixStreamServer(str(CONTROL), Handler)
        finally:
            os.umask(old)
        threading.Thread(target=self.control.serve_forever, daemon=True).start()

    # ---- run and stop

    def run(self) -> int:
        os.umask(0o077)  # the catalog, logs and backups are private too
        try:
            check_data_path()
        except RuntimeError as exc:
            log(f"failed: {exc}")
            return 1
        if not self.take_lock():
            log("another harness already holds the lock on this data folder")
            return 1
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda *_: self.done.set())
        try:
            busy = [p for p in (MCP_PORT, *SCALE_PORTS) if not port_free(p)]
            if busy:
                raise RuntimeError(f"port(s) {busy} on {HOST} are already in use")
            self.clean_data()
            write_private(PIDFILE, f"{os.getpid()}\n")
            self.start_fakes()
            token = self.write_config_and_seed()
            self.start_mcp(token)
            self.write_connection(token)
            del token
            self.start_control()
            log("ready")
            while not self.done.wait(0.5):
                if self.mcp is not None and self.mcp.poll() is not None:
                    log(f"the MCP server exited with code {self.mcp.returncode}. Stopping. See {MCP_LOG}")
                    return 2
            return 0
        except Exception as exc:
            log(f"failed: {type(exc).__name__}: {exc}")
            return 1
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        if self.control is not None:
            self.control.shutdown()
            self.control.server_close()
        mcp = self.mcp
        # Popen is our own unreaped child, so its pid cannot belong to anyone else yet. Check anyway.
        if mcp is not None and mcp.poll() is None:
            if is_our_mcp(mcp.pid):
                mcp.terminate()
                try:
                    mcp.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    if mcp.poll() is None and is_our_mcp(mcp.pid):
                        mcp.kill()
                    mcp.wait()
            else:
                log(f"pid {mcp.pid} is not our MCP server. Not signalling it.")
        if self.mcp_log is not None:
            self.mcp_log.close()
        for fake in self.fakes.values():
            fake.stop()
        # The token lives only in these two files. Neither outlives the harness.
        for p in (CONNECTION, CONFIG, CONTROL):
            p.unlink(missing_ok=True)
        try:
            if PIDFILE.read_text().strip() == str(os.getpid()):
                PIDFILE.unlink()
        except OSError:
            pass
        log("stopped")
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None


# ---------------------------------------------------------------- the control client


def ctl(words: list[str]) -> int:
    if not CONTROL.exists():
        print("The dev harness is not running.", file=sys.stderr)
        return 3
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(30)
            s.connect(str(CONTROL))
            s.sendall((" ".join(words) + "\n").encode())
            data = b""
            while not data.endswith(b"\n"):
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
    except OSError as exc:
        print(f"The dev harness did not answer: {exc}", file=sys.stderr)
        return 3
    reply = json.loads(data or b"{}")
    print(json.dumps(reply, indent=1))
    return 0 if reply.get("ok") else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run")
    run.add_argument("--data", required=True,
                     help="must be this project's data/dev-scaleconnect. It is in the command line so dev-sc.sh can tell this process from any other")
    run.add_argument("--timing", choices=("fast", "real"), default="fast",
                     help="fast: fakes answer at once (default). real: the real scales' waits and busy gap")
    c = sub.add_parser("ctl")
    c.add_argument("words", nargs="+")
    args = ap.parse_args(argv)
    if args.cmd == "ctl":
        return ctl(args.words)
    if args.data != str(DATA):
        print(f"--data must be {DATA}", file=sys.stderr)
        return 1
    if not os.environ.get("PYTHONDONTWRITEBYTECODE"):
        print("Set PYTHONDONTWRITEBYTECODE=1 so nothing is written under ~/CCScaleApp. Use dev-sc.sh.", file=sys.stderr)
        return 1
    return Harness(args.timing).run()


if __name__ == "__main__":
    sys.exit(main())
