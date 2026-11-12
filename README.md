# Gloss

Gloss creates English vocabulary flashcards with Sinhala meanings, two examples, and
pronunciation audio. Review and edit the text, prepare audio, then send the cards to Anki.
The app runs on your computer. Words come from Google or any OpenAI-compatible
endpoint, and Google Cloud records the speech.

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

To do the Windows steps in one go, run `scripts\setup-windows.ps1` in PowerShell. It
installs Git and uv when missing, clones the latest release, downloads the optional
local voice, writes the private `.env` and settings, creates a desktop shortcut, and
lists the Anki steps still needed. Pass `-ApiKey` or paste the key when prompted.

Google Application Default Credentials also work. The default models are
`gemini-3.8-flash` and `gemini-3.8-flash-tts` on the global endpoint. Your project needs
access to those models, billing, and prediction permission. Gloss does not create
cloud projects, keys, or IAM roles. Generation makes billable API calls.

To write words through an OpenAI-compatible `/chat/completions` endpoint instead, set
`TEXT_API_BASE` (including `/v1`) and `TEXT_API_KEY` in the private `.env`. Text then
comes from that endpoint and Google is only used for audio. Without a Google project,
words still generate and audio stays off. The text model stays `gemini-3.8-flash` unless
you change it in Settings, so choose a model the endpoint accepts.

Audio makes four clips per card with Google Cloud by default. To record them on your own
computer instead, download the two-voice
[Underdog Woof](https://huggingface.co/ConwayResearch/Underdog-Woof) model into a folder
and set `WOOF_MODEL_DIR` to it in the private `.env`. Set `WOOF_VOICE` to `juno` (default)
or `mira`. Woof runs on a CPU with numpy and needs no network, so with a text endpoint and
Woof, Google is not needed at all. Its weights are licensed for non-commercial use, so
Gloss does not bundle or download them, and the model folder stays outside the checkout.

## Use

Paste words separated by newlines, commas, or semicolons. Add context with `word: hint`.
Choose a deck once for the batch, then generate. Ctrl+Enter or Cmd+Enter also starts generation.

Gloss records audio for the word, definition, and both examples right after it writes
the words. You can keep editing while audio records. Saving an edit re-records only the
changed clip. If some clips fail, choose **Prepare audio** to retry them. Turn off automatic
audio in Settings to record only when you choose **Prepare audio**. New words join the
unsynced words already in the batch for the same deck.
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
git tag v0.1.1
git push origin v0.1.1
```

After the checks pass, CI publishes the frontend ZIP, SHA-256 checksum, wheel, and
source distribution. It keeps the release in draft until every asset is uploaded.
The Windows launcher uses `gloss-frontend.zip` and `gloss-frontend.sha256`.

## Fonts and licenses

Gloss uses MIT. Bundled fonts and icons retain their own licenses.
See [THIRD_PARTY.md](THIRD_PARTY.md) for notices and template provenance.

Voice by Underdog Woof when the local model is selected. Woof's weights are released
under the Underdog Non-Commercial License 1.0 and are not distributed with Gloss.
Credit "Underdog Woof" or "underdog.ai" in anything you publish using its audio, and
show "Voice by Underdog Woof" in any app that uses it. Commercial use needs a separate
licence from Underdog.

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
