import importlib.util
import zipfile
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "gloss_launcher", Path(__file__).parents[1] / "scripts/launch.py"
)
assert spec is not None and spec.loader is not None
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def test_frontend_archive_rejects_traversal_and_hidden_files(tmp_path):
    for filename in ("../escape", ".env", r"..\escape"):
        archive = tmp_path / "bundle.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(filename, "bad")
            bundle.writestr("index.html", "ok")
        with pytest.raises(ValueError):
            launcher.safe_extract(archive, tmp_path / "destination")


def test_valid_frontend_archive_extracts_and_requires_index(tmp_path):
    archive = tmp_path / "bundle.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("index.html", "ok")
        bundle.writestr("assets/app.js", "ok")
    destination = tmp_path / "frontend"
    launcher.safe_extract(archive, destination)
    assert (destination / "assets/app.js").read_text() == "ok"


def test_failed_dependency_update_rolls_back_backend_and_preserves_old_bundle(
    tmp_path, monkeypatch
):
    import hashlib
    import io
    import json
    import subprocess

    config = tmp_path / "config"
    config.mkdir()
    old_frontend = config / "old"
    old_frontend.mkdir()
    (old_frontend / "index.html").write_text("old")
    state = {"tag": "v0.1.0", "commit": "old-commit", "frontend": str(old_frontend)}
    state_path = config / "installed-release.json"
    state_path.write_text(json.dumps(state))
    monkeypatch.setattr(launcher, "CONFIG", config)
    monkeypatch.setattr(launcher, "release_repo", lambda: "owner/gloss")
    monkeypatch.setattr(
        launcher,
        "get_json",
        lambda _: {
            "tag_name": "v0.2.0",
            "assets": [
                {
                    "name": name,
                    "browser_download_url": f"https://github.com/owner/gloss/releases/download/v0.2.0/{name}",
                }
                for name in ("gloss-frontend.zip", "gloss-frontend.sha256")
            ],
        },
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("index.html", "new")
    data = buffer.getvalue()
    checksum = hashlib.sha256(data).hexdigest().encode()
    monkeypatch.setattr(
        launcher.urllib.request,
        "urlopen",
        lambda url, **kwargs: io.BytesIO(data if url.endswith(".zip") else checksum),
    )
    commit = "old-commit"

    def run(*args, **kwargs):
        nonlocal commit
        if args[:3] == ("git", "rev-parse", "HEAD"):
            return commit
        if args[:3] == ("git", "checkout", "--detach"):
            commit = "new-commit" if args[3] == "v0.2.0" else args[3]
        if args[0] == "uv" and commit == "new-commit":
            raise subprocess.CalledProcessError(1, args)
        return ""

    monkeypatch.setattr(launcher, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        launcher.update("uv")
    assert commit == "old-commit"
    assert json.loads(state_path.read_text()) == state
    assert (old_frontend / "index.html").read_text() == "old"
