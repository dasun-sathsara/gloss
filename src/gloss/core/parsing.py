import re

from gloss.core.models import Entry, normalized


def parse_entries(text: str) -> list[Entry]:
    if len(text) > 20_000:
        raise ValueError("Paste at most 20,000 characters.")
    entries: list[Entry] = []
    seen: set[tuple[str, str]] = set()
    for raw in re.split(r"[\n,;]", text):
        raw = raw.strip()
        if not raw:
            continue
        parts = re.split(r"\s*:\s*|\s+-\s+", raw, maxsplit=1)
        word, hint = parts[0].strip(), parts[1].strip() if len(parts) == 2 else ""
        key = (normalized(word), normalized(hint))
        warning = "Enter a word before the hint." if not word else ""
        if len(word) > 120 or len(hint) > 500:
            warning = "This entry is too long. Use a word or a short phrase."
        entries.append(
            Entry(index=len(entries), word=word, hint=hint, duplicate=key in seen, warning=warning)
        )
        seen.add(key)
        if len(entries) > 100:
            raise ValueError("Paste at most 100 entries at a time.")
    return entries
