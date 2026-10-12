from typing import Any

import httpx

from gloss.core.ports import ProviderError


class AnkiClient:
    def __init__(self, http: httpx.AsyncClient, port: int = 8765):
        self.http = http
        self.url = f"http://127.0.0.1:{port}"

    async def call(self, action: str, **params: Any) -> Any:
        try:
            response = await self.http.post(
                self.url,
                json={
                    "action": action,
                    "version": 6,
                    "params": params,
                },
                timeout=30,
            )
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError("Open Anki with AnkiConnect enabled, then try again.") from exc
        if not isinstance(data, dict) or "result" not in data or "error" not in data:
            raise ProviderError("AnkiConnect returned an unexpected response. Check its version.")
        if error := data["error"]:
            # Anki errors can include private note content. Only display known categories.
            if "sync" in str(error).lower():
                raise ProviderError("Finish or resolve the sync in Anki, then try again.")
            raise ProviderError(f"AnkiConnect could not complete {action}. Check Anki.")
        return data["result"]

    async def multi(self, actions: list[dict[str, Any]]) -> list[Any]:
        results = await self.call("multi", actions=[{**action, "version": 6} for action in actions])
        if not isinstance(results, list) or len(results) != len(actions):
            raise ProviderError("AnkiConnect returned an incomplete group of results.")
        for result in results:
            if not isinstance(result, dict) or result.get("error"):
                raise ProviderError("One Anki operation failed. Completed operations are saved.")
        return [result["result"] for result in results]
