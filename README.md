# Gloss

Gloss creates English vocabulary flashcards with Sinhala meanings, two examples, and
pronunciation audio. Review and edit the text, prepare audio, then send the cards to Anki.
The app runs on your computer. Google Cloud handles text and speech generation.

## Windows setup

1. Install [Anki](https://apps.ankiweb.net/) and
   [AnkiConnect](https://ankiweb.net/shared/info/2055492159), then restart Anki.
2. Clone this repository with Git. Open the checkout and double-click `Gloss.cmd`.
   The launcher installs Git and uv through winget when needed, downloads the latest
   release, and opens <http://127.0.0.1:8776>. Node and system FFmpeg are not required.
3. Copy [.env.example](.env.example) to `%APPDATA%\Gloss\.env`. Fill in your Google Cloud
   project and the path to your private service-account key, then restart Gloss.
4. Keep Anki open. In Gloss, open **Anki** and choose **Set up Anki**.

AnkiConnect uses port 8765 by default. If your add-on uses another port, set
`ANKI_CONNECT_PORT` in the private `.env` to match its `webBindPort`.

Google Application Default Credentials also work. The default models are
`gemini-3.8-flash` and `gemini-3.8-flash-tts` on the global endpoint. Your project needs
access to those models, billing, and prediction permission. Gloss does not create
cloud projects, keys, or IAM roles. Generation makes billable API calls.

## Use

Paste words separated by newlines, commas, or semicolons. Add context with `word: hint`.
Choose a deck once for the batch, then generate. Ctrl+Enter or Cmd+Enter also starts generation.

Edit each card before choosing **Prepare audio**. Gloss creates audio for the word,
definition, and both examples. Editing a field invalidates only its clip.
Choose **Sync to Anki** when the selected cards are ready. For conflicting meanings,
keep both, overwrite, or skip. Updates preserve the existing note and review history.
Changing a synced word or part of speech creates a new identity and leaves the old note in Anki.

Setup creates a `Gloss` note type and a `Gloss` deck tree. The answer plays the word;
compact play buttons control the other clips. Finish any sync prompts in Anki to send
changes to your phone. Gloss cannot choose a full upload or download for you.

## Data and updates

Data lives in `%APPDATA%\Gloss` on Windows and `~/.config/gloss` elsewhere.
Set `GLOSS_CONFIG_DIR` to use another directory. It contains the private `.env`,
settings, SQLite library, cached audio, logs, and installed release files.
Back up this directory while Gloss is stopped. Restore to a separate directory first.

`Gloss.cmd` checks completed GitHub releases at startup. It verifies the frontend
checksum before switching the backend to the matching tag. Failed updates keep the
installed version. Modified checkouts skip updates and use their local frontend build.
The launcher reads the repository from Git's origin or `GLOSS_RELEASE_REPO` in the private `.env`.
Closing the browser leaves the server running. Stop the server before changing its configuration.

## Local development

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and
[pnpm](https://pnpm.io/installation). uv manages Python 3.13.

```sh
uv sync --frozen
cd frontend
pnpm install --frozen-lockfile
pnpm build
cd ..
uv run gloss
```

For frontend development, run `uv run gloss --no-browser` and `pnpm dev` in `frontend/`.
For an offline demo with isolated data:

```sh
GLOSS_CONFIG_DIR=/path/to/scratch/gloss-demo uv run gloss --demo
```

The demo recognizes `curious`, `resilient`, and `record`. Its audio is a test tone.

Run the checks before committing:

```sh
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest
uv run python scripts/encoder_smoke.py
cd frontend
pnpm check
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

## Releases

GitHub Actions checks the backend and encoder on Windows and Linux, runs frontend
checks and browser tests, and verifies the Python distributions. To release, update
both `pyproject.toml` and `frontend/package.json`, commit, and push a matching tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

After the checks pass, CI publishes the frontend ZIP, SHA-256 checksum, wheel, and
source distribution. It keeps the release in draft until every asset is uploaded.
The Windows launcher uses `gloss-frontend.zip` and `gloss-frontend.sha256`.

## Fonts and licenses

Gloss uses MIT. Bundled fonts and icons retain their own licenses.
See [THIRD_PARTY.md](THIRD_PARTY.md) for notices and template provenance.

Geist Mono and Noto Sans Sinhala are bundled. Studio Feixen Sans is private and
excluded from Git and release packages. To use your licensed copy, place it at
`<config directory>/fonts/_StudioFeixenSansVariable.ttf`, then run Anki setup.
Without it, the card uses a system sans font.

The web app and Anki playback buttons use Phosphor. After updating the icon dependency,
run `pnpm icons:export` in `frontend/` and run Anki setup again.
`uv run python scripts/template_sync.py` also installs and verifies the card template.

Browser tests cover playback and the demo workflow. Live generation and Anki note
updates have been checked on macOS. A fresh Windows installation and playback on
Anki mobile clients still need manual verification.
