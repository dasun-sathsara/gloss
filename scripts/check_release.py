"""Check public distributions and assemble the frontend assets used by the launcher."""

import argparse
import hashlib
import json
import re
import shutil
import tarfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check_members(names: list[str]) -> None:
    for name in names:
        parts = Path(name).parts
        for part in parts:
            lower = part.lower()
            credentials = lower.endswith(".json") and (
                lower.endswith("sa.json")
                or "credential" in lower
                or lower.startswith("service-account")
                or lower.endswith("-key.json")
            )
            if (
                part
                in {".env", ".venv", "node_modules", "__pycache__", "_StudioFeixenSansVariable.ttf"}
                or (part.startswith(".env.") and part != ".env.example")
                or part.endswith((".pem", ".sqlite3", ".mp3", ".wav"))
                or credentials
            ):
                raise ValueError(f"Private or generated file in distribution: {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    parser.add_argument("--frontend", type=Path)
    args = parser.parse_args()
    version = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
    web_version = json.loads((ROOT / "frontend/package.json").read_text())["version"]
    if version != web_version:
        raise ValueError("Backend and frontend versions differ.")
    if args.tag and (not re.fullmatch(r"v\d+\.\d+\.\d+", args.tag) or args.tag != f"v{version}"):
        raise ValueError("Release tag must match both package versions.")
    distributions = list((ROOT / "dist").glob("*.whl")) + list((ROOT / "dist").glob("*.tar.gz"))
    if len(distributions) != 2:
        raise ValueError("Expected one wheel and one source distribution.")
    for path in distributions:
        if path.name not in {f"gloss-{version}-py3-none-any.whl", f"gloss-{version}.tar.gz"}:
            raise ValueError(f"Unexpected distribution version: {path.name}")
        if path.suffix == ".whl":
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
        else:
            with tarfile.open(path) as archive:
                names = archive.getnames()
        check_members(names)
        if not any(name.endswith("LICENSE") for name in names):
            raise ValueError(f"Missing project license in {path.name}")
        for asset in (
            "vocabulary.css",
            "vocabulary.js",
            "playback-icons.json",
            "Phosphor-Icons-MIT.txt",
        ):
            if not any(name.endswith(asset) for name in names):
                raise ValueError(f"Missing card asset {asset} in {path.name}")
    if args.frontend:
        frontend = args.frontend.resolve()
        if not all(
            (frontend / name).is_file() for name in ("index.html", "THIRD_PARTY_LICENSES.txt")
        ):
            raise ValueError("Frontend is missing its entry point or dependency notices.")
        for name in ("LICENSE", "THIRD_PARTY.md"):
            shutil.copyfile(ROOT / name, frontend / name)
        shutil.copyfile(
            ROOT / "src/gloss/assets/licenses/Phosphor-Icons-MIT.txt",
            frontend / "Phosphor-Icons-MIT.txt",
        )
        check_members([str(path.relative_to(frontend)) for path in frontend.rglob("*")])
        bundle = Path(shutil.make_archive(str(ROOT / "gloss-frontend"), "zip", frontend))
        digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
        (ROOT / "gloss-frontend.sha256").write_text(f"{digest}  {bundle.name}\n")
    print(f"Public release files verified for v{version}.")


if __name__ == "__main__":
    main()
