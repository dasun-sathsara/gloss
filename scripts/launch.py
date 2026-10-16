"""Standard-library launcher. Runs with uv-managed Python, before project dependencies exist."""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = (
    Path(
        os.environ.get(
            "GLOSS_CONFIG_DIR",
            Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Gloss"
            if sys.platform == "win32"
            else Path.home() / ".config" / "gloss",
        )
    )
    .expanduser()
    .resolve()
)
URL = "http://127.0.0.1:8776"


def refresh_windows_path() -> None:
    if sys.platform != "win32":
        return
    import winreg

    values = []
    for hive, key in [
        (
            winreg.HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
        (winreg.HKEY_CURRENT_USER, "Environment"),
    ]:
        with contextlib.suppress(OSError), winreg.OpenKey(hive, key) as handle:
            values.append(os.path.expandvars(winreg.QueryValueEx(handle, "Path")[0]))
    os.environ["PATH"] = os.pathsep.join([os.environ.get("PATH", ""), *values])


def run(*args: str, cwd: Path = ROOT) -> str:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True, timeout=300)
    return result.stdout.strip()


def get_json(url: str):
    request = urllib.request.Request(
        url, headers={"User-Agent": "Gloss-launcher", "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def safe_extract(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as bundle:
        if sum(info.file_size for info in bundle.infolist()) > 100_000_000:
            raise ValueError("The frontend bundle is too large.")
        for info in bundle.infolist():
            target = (destination / info.filename).resolve()
            if not target.is_relative_to(destination.resolve()) or "\\" in info.filename:
                raise ValueError("Unsafe frontend bundle path.")
            if any(part.startswith(".") for part in Path(info.filename).parts):
                raise ValueError("Frontend bundles cannot contain hidden files.")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Frontend bundles cannot contain symlinks.")
        bundle.extractall(destination)
    if not (destination / "index.html").is_file():
        raise ValueError("The frontend bundle has no index.html.")


def release_repo() -> str:
    configured = os.environ.get("GLOSS_RELEASE_REPO", "")
    env_path = CONFIG / ".env"
    if not configured and env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("GLOSS_RELEASE_REPO="):
                configured = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not configured:
        with contextlib.suppress(subprocess.SubprocessError):
            origin = run("git", "remote", "get-url", "origin")
            match = re.fullmatch(
                r"(?:https://github.com/|git@github.com:)([\w.-]+/[\w.-]+?)(?:\.git)?", origin
            )
            if match:
                configured = match[1]
    if configured and not re.fullmatch(r"[\w.-]+/[\w.-]+", configured):
        raise ValueError("GLOSS_RELEASE_REPO must be a GitHub owner/repository.")
    return configured


def update(uv: str) -> Path | None:
    state_path = CONFIG / "installed-release.json"
    installed = json.loads(state_path.read_text()) if state_path.is_file() else None
    current_frontend = Path(installed["frontend"]) if installed else None
    repository = release_repo()
    if not repository:
        return current_frontend
    release = get_json(f"https://api.github.com/repos/{repository}/releases/latest")
    tag = release["tag_name"]
    if (
        release.get("draft")
        or release.get("prerelease")
        or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag)
    ):
        raise ValueError("The latest release is not a completed version tag.")
    assets = {asset["name"]: asset for asset in release.get("assets", [])}
    if not {"gloss-frontend.zip", "gloss-frontend.sha256"}.issubset(assets):
        raise ValueError("The release is still missing its frontend assets.")
    previous = run("git", "rev-parse", "HEAD")
    dirty = bool(run("git", "status", "--porcelain"))
    if installed:
        target_version = tuple(int(part) for part in tag.removeprefix("v").split("."))
        installed_version = tuple(
            int(part) for part in installed["tag"].removeprefix("v").split(".")
        )
        if target_version < installed_version:
            raise ValueError("The published release is older than the installed version.")
    if (
        installed
        and installed["tag"] == tag
        and current_frontend
        and current_frontend.is_dir()
        and installed.get("commit") == previous
        and not dirty
    ):
        return current_frontend
    # Preserve developer changes. Clients should update only clean, released checkouts.
    if dirty:
        logging.warning("Update skipped because the checkout has local changes.")
        # A cached release cannot accompany modified backend source.
        local = ROOT / "frontend/dist"
        return local if (local / "index.html").is_file() else None
    cache = CONFIG / "releases"
    stage = cache / f"{tag}-staging"
    final = cache / tag
    cache.mkdir(parents=True, exist_ok=True)
    stage.mkdir(exist_ok=True)
    archive = cache / f"{tag}.zip"
    download_url = assets["gloss-frontend.zip"]["browser_download_url"]
    checksum_url = assets["gloss-frontend.sha256"]["browser_download_url"]
    if not download_url.startswith(
        f"https://github.com/{repository}/releases/download/"
    ) or not checksum_url.startswith(f"https://github.com/{repository}/releases/download/"):
        raise ValueError("The release asset URL has an unexpected owner.")
    with urllib.request.urlopen(download_url, timeout=60) as response, archive.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    with urllib.request.urlopen(checksum_url, timeout=20) as response:
        expected = response.read(1024).decode().split()[0]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise ValueError("The frontend checksum does not match.")
    safe_extract(archive, stage)
    run("git", "fetch", "origin", "--tags")
    try:
        run("git", "checkout", "--detach", tag)
        run(uv, "sync", "--frozen", "--no-dev")
        if final.exists():
            # Reuse an already verified release cache after an interrupted launch.
            safe_extract(archive, final)
        else:
            stage.rename(final)
        temporary = state_path.with_suffix(".tmp")
        commit = run("git", "rev-parse", "HEAD")
        temporary.write_text(json.dumps({"tag": tag, "frontend": str(final), "commit": commit}))
        temporary.replace(state_path)
        return final
    except Exception:
        run("git", "checkout", "--detach", previous)
        run(uv, "sync", "--frozen", "--no-dev")
        raise


def healthy() -> bool:
    try:
        return get_json(URL + "/api/health").get("app") == "gloss"
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        logging.debug("Health probe failed: %s", exc)
        return False


def raw_head() -> str:
    with contextlib.suppress(Exception):
        return run("git", "rev-parse", "HEAD")
    return ""


def install_state() -> str | None:
    state_path = CONFIG / "installed-release.json"
    if state_path.is_file():
        with contextlib.suppress(OSError):
            return state_path.read_text()
    return None


def restore_installation(uv: str, commit: str, state: str | None) -> bool:
    """Best-effort rollback to the checkout and state from before a failed update."""
    try:
        run("git", "checkout", "--detach", commit)
        run(uv, "sync", "--frozen", "--no-dev")
    except Exception:
        logging.exception("Rollback to %s failed", commit)
        return False
    state_path = CONFIG / "installed-release.json"
    with contextlib.suppress(OSError):
        if state is None:
            if state_path.exists():
                state_path.unlink()
        else:
            state_path.write_text(state)
    return True


def start(uv: str, frontend: Path) -> bool:
    try:
        run(uv, "sync", "--frozen", "--no-dev")
        args = [uv, "run", "--no-sync", "gloss", "--no-browser", "--frontend", str(frontend)]
        with (CONFIG / "startup.log").open("a") as log:
            child = subprocess.Popen(
                args,
                cwd=ROOT,
                stdout=log,
                stderr=log,
                **(
                    {"creationflags": subprocess.CREATE_NO_WINDOW}
                    if sys.platform == "win32"
                    else {}
                ),
            )
    except Exception:
        logging.exception("Could not start Gloss")
        return False
    for _ in range(60):
        if healthy():
            with contextlib.suppress(Exception):
                webbrowser.open(URL)
            return True
        if child.poll() is not None:
            return False
        time.sleep(0.5)
    with contextlib.suppress(Exception):
        child.terminate()
        child.wait(timeout=10)
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
    return False


@contextlib.contextmanager
def launcher_lock():
    with (CONFIG / "launcher.lock").open("a+b") as handle:
        handle.seek(0)
        if sys.platform == "win32":
            import msvcrt

            handle.write(b"0")
            handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError(
                    "Gloss is already starting. Wait for its browser window."
                ) from exc
        else:
            import fcntl

            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main() -> None:
    refresh_windows_path()
    CONFIG.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        with contextlib.suppress(OSError):
            os.chmod(CONFIG, 0o700)
    os.environ["GLOSS_CONFIG_DIR"] = str(CONFIG)
    logging.basicConfig(
        filename=CONFIG / "startup.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    if healthy():
        webbrowser.open(URL)
        return
    with launcher_lock():
        uv = shutil.which("uv")
        if not uv:
            raise RuntimeError("Install uv, then run Gloss.cmd again.")
        run("git", "config", "core.autocrlf", "false")
        previous_commit = raw_head()
        previous_state = install_state()
        frontend = None
        try:
            frontend = update(uv)
        except Exception as exc:
            logging.warning("Update failed: %s. Keeping the installed version.", exc)
            with contextlib.suppress(Exception):
                state = CONFIG / "installed-release.json"
                if state.is_file():
                    installed = json.loads(state.read_text())
                    if installed.get("commit") == raw_head() and not run(
                        "git", "status", "--porcelain"
                    ):
                        frontend = Path(installed["frontend"])
        frontend = frontend or ROOT / "frontend/dist"
        if not (frontend / "index.html").is_file():
            raise RuntimeError(
                "No completed frontend release is installed. See README.md for first setup."
            )
        if start(uv, frontend):
            return
        # The installed release did not come up. Roll back to the previous checkout
        # and state (or the local build on a fresh checkout), then try that instead of
        # leaving a bad release pinned.
        previous_frontend = None
        if previous_state:
            with contextlib.suppress(ValueError, KeyError, TypeError):
                previous_frontend = Path(json.loads(previous_state)["frontend"])
        if previous_frontend is None:
            local = ROOT / "frontend/dist"
            if (local / "index.html").is_file():
                previous_frontend = local
        if (
            previous_commit
            and previous_commit != raw_head()
            and previous_frontend is not None
            and (previous_frontend / "index.html").is_file()
        ):
            logging.warning("New release did not start; restoring the previous checkout.")
            if restore_installation(uv, previous_commit, previous_state) and start(
                uv, previous_frontend
            ):
                return
            raise RuntimeError(
                "The update could not start and the previous version also failed. "
                "Read startup.log in the config directory."
            )
        raise RuntimeError("Gloss could not start. Read startup.log in the config directory.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc))
        print(f"Startup log: {CONFIG / 'startup.log'}")
        sys.exit(1)
