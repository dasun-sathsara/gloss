import argparse
import logging
import os
import webbrowser
from pathlib import Path

import uvicorn
from filelock import FileLock, Timeout

from gloss.api.app import create_app
from gloss.config import Configuration, config_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Start Gloss on this computer.")
    parser.add_argument("--port", type=int, default=8776)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--demo", action="store_true", help="Use offline development fixtures.")
    parser.add_argument("--frontend", type=Path)
    args = parser.parse_args()
    directory = config_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    logging.basicConfig(
        filename=directory / "server.log",
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    configuration = Configuration(directory)
    frontend = args.frontend or Path(os.environ.get("GLOSS_FRONTEND_DIR", "frontend/dist"))
    lock = FileLock(configuration.directory / "server.lock")
    try:
        with lock.acquire(timeout=0):
            if not args.no_browser:
                # The launcher waits for health before opening. Direct CLI launches use a timer.
                import threading

                threading.Timer(
                    1.5, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}")
                ).start()
            uvicorn.run(
                create_app(configuration, frontend, demo=args.demo),
                host="127.0.0.1",
                port=args.port,
                access_log=False,
            )
    except Timeout:
        print("Gloss is already running.")
        if not args.no_browser:
            webbrowser.open(f"http://127.0.0.1:{args.port}")
