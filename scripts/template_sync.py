"""Install and verify Gloss templates through the application's Anki gateway."""

import asyncio

import httpx

from gloss.anki.client import AnkiClient
from gloss.anki.gateway import AnkiGateway
from gloss.config import Configuration
from gloss.library.store import Library


async def main() -> None:
    config = Configuration()
    library = Library(config.directory)
    try:
        async with httpx.AsyncClient(trust_env=False) as http:
            gateway = AnkiGateway(
                AnkiClient(http, port=config.environment.anki_connect_port), library
            )
            await gateway.setup(config.preferences)
            print("Gloss templates, CSS, and available fonts were uploaded and verified.")
    finally:
        library.close()


if __name__ == "__main__":
    asyncio.run(main())
