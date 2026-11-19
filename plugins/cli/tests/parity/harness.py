import base64
import difflib
import hashlib
import json
import os
import re
import shutil
import signal
import site
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

CLI = Path(__file__).resolve().parents[2]
CRATE = CLI / "rust"
SERVED_TABLE = CRATE / "served.txt"
CASES = Path(__file__).resolve().parent / "cases"
BLOBS = Path(__file__).resolve().parent / "blobs.json"
INSTALL_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
KEPT_ENV = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL")
VOLATILE = ("uuid", "timestamp")
VOLATILE_PROPERTIES = ("$session_id", "total_ms", "startup_ms", "served_by")
QUEUED = {"uuid": "0190a1b2-c3d4-7e5f-8a9b-000000000001", "event": "cli_command", "distinct_id": INSTALL_ID,
          "timestamp": "2026-01-01T00:00:00.000Z", "properties": {"command": "earlier"}}
DEFAULT_HELLO = {"result": {"app": "Ardia", "version": "1.0"}}
STUBBED_HELPERS = ("open", "xdg-open", "osascript", "security", "esbuild", "cua-driver", "git", "node", "pbcopy", "pbpaste",
                   "screencapture", "ffmpeg", "defaults", "launchctl", "say", "afplay")
OBSERVED_APART = ("data/Telemetry/local", "data/Telemetry/cli-queue.jsonl", "data/Telemetry/cli-flush.json", "data/Telemetry/cli-flush.lock",
                  "cli-home/Usage/usage.json", "helpers.log")
TIME_KEYS = re.compile(r"(_at|At|_ms|time|Time)$")
SIDES = ("rust", "python")
TIMEOUT = 60


def binary() -> Path | None:
    named = os.environ.get("ARDIA_RUST_CLI")
    if named:
        return Path(named)
    for profile in ("release", "debug"):
        found = CRATE / "target" / profile / "ardia"
        if found.exists():
            return found
    return None


def command_of(argv: list, python_label: str | None) -> str | None:
    if list(argv) == ["--version"]:
        return "--version"
    if list(argv) in ([], ["--help"], ["-h"]):
        return "--help"
    return python_label


def served_commands(path: Path = SERVED_TABLE) -> list[str]:
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(line)
    return rows


_blob_store = {}


def blob_store() -> dict:
    if not _blob_store and BLOBS.exists():
        _blob_store.update(json.loads(BLOBS.read_text()))
    return _blob_store


def decode_blob(value) -> bytes:
    if value is None:
        return b""
    if isinstance(value, dict) and "blob" in value:
        return decode_blob(blob_store()[value["blob"]])
    if isinstance(value, dict) and "text" in value:
        return value["text"].encode()
    if isinstance(value, str):
        return value.encode()
    if isinstance(value, dict) and "base64" in value:
        return base64.b64decode(value["base64"])
    if isinstance(value, dict) and "json" in value:
        return json.dumps(value["json"]).encode()
    raise ValueError(f"not a blob: {value!r}")


def file_bytes(spec, places: dict) -> bytes:
    if isinstance(spec, dict) and "blob" in spec:
        return file_bytes(blob_store()[spec["blob"]], places)
    if isinstance(spec, str):
        return expand(spec, places).encode()
    if isinstance(spec, dict) and "text" in spec:
        return expand(spec["text"], places).encode()
    return decode_blob(spec)


@dataclass
class Case:
    id: str
    command: str
    argv: list
    stdin: object = None
    env: dict = field(default_factory=dict)
    control: dict | None = field(default_factory=dict)
    consent: dict = field(default_factory=dict)
    files: dict = field(default_factory=dict)
    helpers: dict = field(default_factory=dict)
    fallback: bool = False
    normalize: list = field(default_factory=list)
    source: str = ""
    note: str = ""

    @classmethod
    def from_dict(cls, row: dict, source: str) -> "Case":
        known = {name for name in cls.__dataclass_fields__}
        unknown = set(row) - known
        if unknown:
            raise ValueError(f"{source}: case {row.get('id')!r} has unknown keys {sorted(unknown)}")
        return cls(**{**row, "source": source})

    def to_dict(self) -> dict:
        row = {"id": self.id, "command": self.command, "argv": self.argv}
        defaults = Case(id="", command="", argv=[])
        for name in ("stdin", "env", "control", "consent", "files", "helpers", "fallback", "normalize", "note"):
            value = getattr(self, name)
            if value != getattr(defaults, name):
                row[name] = value
        return row


def load_cases(root: Path = CASES) -> list[Case]:
    cases, seen = [], {}
    for path in sorted(root.rglob("*.json")) + sorted(root.rglob("*.jsonl")):
        source = str(path.relative_to(root))
        if path.suffix == ".jsonl":
            rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        else:
            rows = json.loads(path.read_text())
        for row in rows:
            case = Case.from_dict(row, source)
            if case.id in seen:
                raise ValueError(f"case id {case.id!r} is in both {seen[case.id]} and {source}")
            seen[case.id] = source
            cases.append(case)
    return cases


class FakeArdia:
    def __init__(self, path: Path, hello, replies: dict, events: list):
        self.hello = hello
        self.replies = {method: list(reply) if isinstance(reply, list) else [reply] for method, reply in replies.items()}
        self.events = events
        self.requests = []
        self.lock = threading.Lock()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        self.server.listen(16)
        self.server.settimeout(0.1)
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while not self.stopped.is_set():
            try:
                connection, _ = self.server.accept()
            except (socket.timeout, OSError):
                continue
            threading.Thread(target=self.talk, args=(connection,), daemon=True).start()

    def next_reply(self, method):
        if method == "hello":
            return self.hello
        with self.lock:
            queue = self.replies.get(method)
            if not queue:
                return {"result": None}
            reply = queue.pop(0) if len(queue) > 1 else queue[0]
        return reply() if callable(reply) else reply

    def talk(self, connection):
        try:
            with connection, connection.makefile("rb") as lines:
                for line in lines:
                    try:
                        request = json.loads(line)
                    except ValueError:
                        self.requests.append(("<not json>", line.decode("utf-8", "backslashreplace")))
                        continue
                    method = request.get("method")
                    with self.lock:
                        self.requests.append((method, request.get("params")))
                    reply = self.next_reply(method)
                    if reply == "close":
                        return
                    if isinstance(reply, dict) and "raw" in reply:
                        connection.sendall(decode_blob(reply["raw"]))
                        continue
                    if isinstance(reply, dict) and "hang" in reply:
                        self.stopped.wait(float(reply["hang"]))
                        return
                    connection.sendall(json.dumps({"id": request.get("id"), **reply}).encode() + b"\n")
                    if method == "subscribe":
                        for event in self.events:
                            connection.sendall(json.dumps(event).encode() + b"\n")
        except OSError:
            pass

    def close(self):
        self.stopped.set()
        self.server.close()
        self.thread.join(2)


@dataclass
class Observed:
    stdout: bytes
    stderr: bytes
    status: int
    requests: list
    telemetry: list
    queued: list
    served_by: list
    usage: object
    files: dict
    helpers: list
    timed_out: bool = False


def tree(root: Path) -> dict:
    found = {}
    if not root.exists():
        return found
    for path in sorted(root.rglob("*")):
        rel = str(path.relative_to(root))
        if any(rel == apart or rel.startswith(apart + "/") for apart in OBSERVED_APART):
            continue
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            found[rel] = ("dir", stat.S_IMODE(info.st_mode))
        elif stat.S_ISLNK(info.st_mode):
            found[rel] = ("link", os.readlink(path))
        elif stat.S_ISSOCK(info.st_mode):
            found[rel] = ("socket",)
        elif stat.S_ISREG(info.st_mode):
            body = path.read_bytes()
            found[rel] = ("file", stat.S_IMODE(info.st_mode), body)
        else:
            found[rel] = ("other",)
    return found


def file_changes(before: dict, after: dict) -> dict:
    changes = {}
    for rel in sorted(set(before) | set(after)):
        old, new = before.get(rel), after.get(rel)
        if old == new:
            continue
        if new is None:
            changes[rel] = ("removed",)
        else:
            changes[rel] = ("written", *new)
    return changes


def scrub_times(value):
    if isinstance(value, dict):
        return {key: "<time>" if TIME_KEYS.search(key) and isinstance(child, (int, float)) else scrub_times(child) for key, child in value.items()}
    if isinstance(value, list):
        return [scrub_times(child) for child in value]
    return value


class Installation:
    def __init__(self, rust_binary: Path, scratch: Path | None = None):
        self.scratch = scratch or Path(tempfile.mkdtemp(prefix="arp", dir="/tmp"))
        self.root = self.scratch / "cli"
        (self.root / "bin").mkdir(parents=True)
        shutil.copy2(rust_binary, self.root / "bin" / "ardia")
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(self.root / "python")], check=True)
        self.python = self.root / "python" / "bin" / "python3"
        packages = subprocess.run([str(self.python), "-I", "-c", "import site; print(site.getsitepackages()[0])"],
                                  check=True, capture_output=True, text=True).stdout.strip()
        (Path(packages) / "ardia-checkout.pth").write_text("\n".join([str(CLI), *site.getsitepackages()]) + "\n")
        self.stubs = self.scratch / "stubs"
        self.stubs.mkdir()
        self.counter = 0
        self.counter_lock = threading.Lock()

    def close(self):
        shutil.rmtree(self.scratch, True)

    def command(self, side: str) -> list[str]:
        return [str(self.root / "bin" / "ardia")] if side == "rust" else [str(self.python), "-I", "-m", "ardia_cli"]

    def box(self) -> Path:
        with self.counter_lock:
            self.counter += 1
            number = self.counter
        return self.scratch / f"c{number}"


def write_stub(directory: Path, name: str, spec: dict, log: Path):
    stdout = base64.b64encode(decode_blob(spec.get("stdout"))).decode()
    status = int(spec.get("exit", 0))
    script = (
        "#!/bin/sh\n"
        f"printf '%s' \"{name}\" >> '{log}'\n"
        f"for a in \"$@\"; do printf ' %s' \"$a\" >> '{log}'; done\n"
        f"printf '\\n' >> '{log}'\n"
        f"printf '%s' '{stdout}' | /usr/bin/base64 -d 2>/dev/null || printf '%s' '{stdout}' | /usr/bin/base64 -D\n"
        f"exit {status}\n"
    )
    path = directory / name
    path.write_text(script)
    path.chmod(0o755)


def materialize(box: Path, case: Case) -> dict:
    for name in ("home", "cli-home", "data", "cwd", "tmp"):
        (box / name).mkdir(parents=True, exist_ok=True)
    data = box / "data"
    consent = case.consent
    if consent is not None and consent.get("absent") is not True:
        (data / "telemetry.json").write_text(json.dumps({"sharing": True, "installId": INSTALL_ID, **consent}))
    telemetry = data / "Telemetry"
    telemetry.mkdir(mode=0o700, exist_ok=True)
    if consent is not None and consent.get("sharing", True) is True:
        (telemetry / "cli-queue.jsonl").write_text(json.dumps(QUEUED) + "\n")
    places = {"box": str(box), "home": str(box / "home"), "cli_home": str(box / "cli-home"), "data": str(data),
              "cwd": str(box / "cwd"), "tmp": str(box / "tmp"), "outside": str(box / "outside"), "cli": str(CLI)}
    (box / "outside").mkdir(exist_ok=True)
    for rel, spec in case.files.items():
        path = box / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(spec, dict) and spec.get("dir"):
            path.mkdir(exist_ok=True)
            continue
        if isinstance(spec, dict) and "link" in spec:
            os.symlink(expand(spec["link"], places), path)
            continue
        path.write_bytes(file_bytes(spec, places))
        if isinstance(spec, dict) and "mode" in spec:
            path.chmod(int(spec["mode"]))
    (telemetry / "cli-flush.json").write_text(json.dumps({"failures": 0, "next_at": 9e12}))
    stubs = box / "stubs"
    stubs.mkdir(exist_ok=True)
    log = box / "helpers.log"
    for name in STUBBED_HELPERS:
        write_stub(stubs, name, case.helpers.get(name, {}), log)
    for name, spec in case.helpers.items():
        if name not in STUBBED_HELPERS:
            write_stub(stubs, name, spec, log)
    return places


def expand(value, places: dict):
    if isinstance(value, str):
        for name, place in places.items():
            value = value.replace("{" + name + "}", place)
        return value
    if isinstance(value, list):
        return [expand(item, places) for item in value]
    if isinstance(value, dict):
        return {key: expand(item, places) for key, item in value.items()}
    return value


def environment(box: Path, places: dict, case: Case) -> dict:
    env = {key: os.environ[key] for key in KEPT_ENV if key in os.environ}
    env["PATH"] = str(box / "stubs") + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    env.update({
        "HOME": places["home"],
        "ARDIA_CLI_HOME": places["cli_home"],
        "ARDIA_DATA_DIR": places["data"],
        "TMPDIR": places["tmp"],
        "ARDIA_TELEMETRY_URL": "http://127.0.0.1:9/v1/logs",
        "http_proxy": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9",
        "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9", "no_proxy": "", "NO_PROXY": "",
        "COLUMNS": "100",
        "LINES": "40",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    for key, value in expand(case.env, places).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


def read_telemetry(data: Path):
    local = data / "Telemetry" / "local"
    records = []
    for path in sorted(local.glob("cli-*.jsonl")) if local.exists() else []:
        records += [json.loads(line) for line in path.read_text().splitlines()]
    spool = data / "Telemetry" / "cli-queue.jsonl"
    queued = [json.loads(line) for line in spool.read_text().splitlines()] if spool.exists() else []
    served = [record.get("properties", {}).get("served_by") for record in records if record.get("event") == "cli_command"]
    labels = [" ".join(part for part in (record.get("properties", {}).get("command"), record.get("properties", {}).get("subcommand")) if part)
              for record in records if record.get("event") == "cli_command"]
    for record in records + queued:
        for key in VOLATILE:
            record.pop(key, None)
        for key in VOLATILE_PROPERTIES:
            record.get("properties", {}).pop(key, None)
    return records, queued, served, labels


def run_side(install: Installation, side: str, case: Case, box: Path) -> tuple[Observed, list]:
    places = materialize(box, case)
    control = case.control
    fake = None
    if control is not None:
        fake = FakeArdia(box / "data" / "ArdiaControl.sock", expand(control.get("hello", DEFAULT_HELLO), places),
                         expand(control.get("replies", {}), places), expand(control.get("events", []), places))
    before = tree(box)
    stdin = decode_blob(expand(case.stdin, places) if isinstance(case.stdin, str) else case.stdin)
    timed_out = False
    try:
        process = subprocess.Popen(install.command(side) + expand(list(case.argv), places), cwd=places["cwd"],
                                   env=environment(box, places, case), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        try:
            stdout, stderr = process.communicate(stdin, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    finally:
        if fake:
            fake.close()
    after = tree(box)
    records, queued, served, labels = read_telemetry(box / "data")
    usage_path = box / "cli-home" / "Usage" / "usage.json"
    usage = scrub_times(json.loads(usage_path.read_text())) if usage_path.exists() else None
    log = box / "helpers.log"
    helpers = log.read_text().splitlines() if log.exists() else []
    observed = Observed(stdout, stderr, process.returncode, fake.requests if fake else [], records, queued, served, usage,
                        file_changes(before, after), helpers, timed_out)
    return apply_normalizers(observed, case, places), labels


def apply_normalizers(observed: Observed, case: Case, places: dict) -> Observed:
    rules = [(re.compile(expand(pattern, {k: re.escape(v) for k, v in places.items()}).encode()), replacement.encode())
             for pattern, replacement in case.normalize]
    if not rules:
        return observed

    def scrub(blob: bytes) -> bytes:
        for pattern, replacement in rules:
            blob = pattern.sub(replacement, blob)
        return blob

    observed.stdout = scrub(observed.stdout)
    observed.stderr = scrub(observed.stderr)
    observed.files = {rel: (change[:3] + (scrub(change[3]),) if change[:2] == ("written", "file") else change) for rel, change in observed.files.items()}
    return observed


def text_of(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "backslashreplace")
    if isinstance(value, dict) and all(isinstance(change, tuple) for change in value.values()):
        lines = []
        for rel, change in value.items():
            if change[:2] == ("written", "file"):
                body = change[3]
                shown = body.decode("utf-8", "backslashreplace") if len(body) < 64 * 1024 else f"<{len(body)} bytes sha256 {hashlib.sha256(body).hexdigest()}>"
                lines.append(f"{rel}: file mode {oct(change[2])}\n{shown}")
            else:
                lines.append(f"{rel}: {change}")
        return "\n".join(lines)
    return json.dumps(value, indent=1, sort_keys=True, ensure_ascii=False, default=str)


FIELDS = ("status", "stdout", "stderr", "requests", "telemetry", "queued", "usage", "files", "helpers", "timed_out")


def compare(rust: Observed, python: Observed, fallback: bool = False) -> list[tuple[str, str]]:
    mismatches = []
    for name in FIELDS:
        left, right = getattr(python, name), getattr(rust, name)
        if name == "requests" and fallback and left and len(right) > len(left):
            right = right[-len(left):]
        if left == right:
            continue
        diff = "\n".join(difflib.unified_diff(text_of(left).splitlines(), text_of(right).splitlines(), "python", "rust", lineterm=""))
        mismatches.append((name, diff or f"python {left!r}\nrust   {right!r}"))
    return mismatches


@dataclass
class Outcome:
    case: Case
    mismatches: list
    rust_served: list
    python_labels: list
    problems: list

    @property
    def passed(self) -> bool:
        return not self.mismatches and not self.problems

    def report(self) -> str:
        lines = [f"✗ {self.case.id} ({self.case.source}): ardia {' '.join(self.case.argv)}"]
        for problem in self.problems:
            lines.append(f"  {problem}")
        for name, diff in self.mismatches:
            lines.append(f"  {name} differs:")
            lines += ["    " + line for line in diff.splitlines()]
        return "\n".join(lines)


def check_case(install: Installation, case: Case, served: set[str], keep: bool = False) -> Outcome:
    box = install.box()
    observed = {}
    labels = []
    for side in SIDES:
        observed[side], side_labels = run_side(install, side, case, box)
        if side == "python":
            labels = side_labels
        if keep:
            box.rename(box.with_name(f"{box.name}-{side}"))
        else:
            shutil.rmtree(box, True)
    problems = []
    rust, python = observed["rust"], observed["python"]
    named = command_of(case.argv, labels[-1] if labels else None)
    if named is not None and named != case.command:
        problems.append(f"this call is {named!r}, the case says {case.command!r}")
    if python.served_by:
        expected = "rust" if case.command in served and not case.fallback else "python"
        if rust.served_by[-1:] != [expected]:
            problems.append(f"expected {expected} to serve it, telemetry says {rust.served_by[-1:]}")
    if python.timed_out:
        problems.append(f"Python didn't finish in {TIMEOUT} s")
    return Outcome(case, compare(rust, python, case.fallback), rust.served_by, labels, problems)


def summarize(outcomes: list[Outcome], served: list[str]) -> dict:
    commands = {}
    for outcome in outcomes:
        row = commands.setdefault(outcome.case.command, {"cases": 0, "passed": 0, "failed": [], "served": outcome.case.command in served})
        row["cases"] += 1
        if outcome.passed:
            row["passed"] += 1
        else:
            row["failed"].append(outcome.case.id)
    for name in served:
        commands.setdefault(name, {"cases": 0, "passed": 0, "failed": [], "served": True})
    proven = sorted(name for name, row in commands.items() if row["cases"] and row["passed"] == row["cases"])
    return {"served": served, "proven": proven, "unproven_but_served": sorted(set(served) - set(proven)), "commands": dict(sorted(commands.items()))}


def run_all(cases: list[Case], rust_binary: Path, jobs: int = 6, keep: bool = False, progress=None) -> tuple[list[Outcome], Installation]:
    from concurrent.futures import ThreadPoolExecutor

    install = Installation(rust_binary)
    served = set(served_commands())
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = [pool.submit(check_case, install, case, served, keep) for case in cases]
        outcomes = []
        for future in futures:
            outcome = future.result()
            outcomes.append(outcome)
            if progress:
                progress(outcome)
    return outcomes, install


def wait_until(test, seconds: float, step: float = 0.05) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if test():
            return True
        time.sleep(step)
    return test()
