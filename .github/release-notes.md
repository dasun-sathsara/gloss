Large batches are now reliable and visible. Generation and audio runs report progress, keep the order you entered, and isolate failures so one bad response no longer discards the rest of the batch.

Other fixes: a renumbered model response can no longer attach a definition to the wrong word; duplicate words that map to one Anki note are surfaced so you can keep both; syncing without complete audio no longer erases audio held only by Anki; a bad update rolls back to the previous release; and an unreadable settings file no longer stops Gloss from starting.

Gloss creates English vocabulary cards with Sinhala meanings, examples, and pronunciation audio for Anki.

Clone the repository and run `Gloss.cmd` on Windows. The launcher downloads the frontend ZIP and verifies its SHA-256 checksum. Configure Google Cloud credentials in your private Gloss config directory and keep AnkiConnect running.

Python distributions are included for manual installation. See the README for setup and development commands. Studio Feixen Sans is not included; supply your licensed copy privately or use the system font fallback.
