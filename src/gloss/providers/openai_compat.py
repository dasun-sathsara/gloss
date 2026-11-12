import httpx

from gloss.config import Preferences
from gloss.core.models import Entry, Generated
from gloss.core.ports import ProviderError
from gloss.providers.text import TEXT_SCHEMA, build_prompt, parse_generated


class ChatCompletionsLanguageModel:
    """Text generation through any OpenAI-compatible /chat/completions endpoint."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        preferences: Preferences,
        max_output_tokens: int = 8192,
        timeout: float = 240.0,
    ):
        if not base_url.startswith(("http://", "https://")):
            raise ProviderError(
                "TEXT_API_BASE must be an http or https URL, for example https://host/v1.",
                fatal=True,
            )
        if not api_key:
            raise ProviderError(
                "Add TEXT_API_KEY for the text endpoint in the config .env.", fatal=True
            )
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.api_key = api_key
        self.model = preferences.text_model
        self.max_output_tokens = max_output_tokens
        self.last_usage: dict = {}
        # No hidden retries: gloss already repairs failed entries, and a slow
        # endpoint must fail before the client gives up on the whole batch.
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=15.0), trust_env=False
        )

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _post(self, body: dict) -> httpx.Response:
        # A cold router can sit on the first request for a minute, and its proxy
        # sometimes answers with a redirect while the container wakes. Nothing has
        # been received yet, so one clean retry is safe; other errors stay immediate.
        for attempt in range(2):
            try:
                response = await self.client.post(
                    self.url,
                    json=body,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
            except httpx.TimeoutException as exc:
                if attempt:
                    raise ProviderError(
                        "The text endpoint timed out. Retry this batch.", retryable=True
                    ) from exc
                continue
            except httpx.HTTPError as exc:
                raise ProviderError(
                    "The text endpoint could not be reached. Check your connection and retry.",
                    retryable=True,
                ) from exc
            if 300 <= response.status_code < 400 and not attempt:
                continue
            return response
        raise AssertionError("unreachable")

    async def generate(self, entries: list[Entry]) -> list[Generated]:
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": build_prompt(entries)}],
            "max_tokens": self.max_output_tokens,
            "stream": False,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "gloss_batch",
                    "strict": True,
                    "schema": TEXT_SCHEMA,
                },
            },
        }
        response = await self._post(body)
        status = response.status_code
        if status in {401, 403}:
            raise ProviderError(
                "The text endpoint rejected the API key. Check TEXT_API_KEY.", fatal=True
            )
        if status == 429:
            raise ProviderError(
                "The text endpoint is rate limited. Wait, then retry.", rate_limited=True
            )
        if status >= 500:
            raise ProviderError(
                f"The text endpoint had a temporary error (HTTP {status}). Retry.",
                retryable=True,
            )
        if status != 200:
            detail = response.text.strip().replace("\n", " ")[:200]
            raise ProviderError(
                f"The text endpoint returned HTTP {status}." + (f" {detail}" if detail else "")
            )

        try:
            payload = response.json()
            choice = payload["choices"][0]
            text = choice["message"].get("content") or ""
            self.last_usage = payload.get("usage") or {}
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError(
                "The text endpoint returned an unexpected response. Retry.", retryable=True
            ) from exc
        if not text.strip():
            raise ProviderError(
                "The text endpoint returned an empty answer. Retry.", retryable=True
            )
        if choice.get("finish_reason") == "length":
            # The schema output was cut off. Repair rounds regenerate the missing entries.
            raise ProviderError(
                "The text endpoint ran out of output tokens. Retry this batch.", retryable=True
            )
        return parse_generated(text, entries)
