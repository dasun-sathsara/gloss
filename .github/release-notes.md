Audio now records on its own. Gloss records the word, definition, and example clips right after it writes the words, and saving an edit re-records only the changed clip. You can keep editing while audio records. When Google's quota is reached, Gloss waits and retries instead of failing the clips. Prepare audio is only needed to retry clips that still failed.

Other fixes: removed words no longer reappear during a run; unsaved edits are no longer replaced by incoming updates; Cancel responds while Anki is slow; the status bar shows each stage with a progress bar; runs end with a summary; failed clips are marked in red; removing words asks first; and new words join the unsynced words already in the batch. Automatic audio can be turned off in Settings.

Gloss creates English vocabulary cards with Sinhala meanings, examples, and pronunciation audio for Anki.

Clone the repository and run `Gloss.cmd` on Windows. The launcher downloads the frontend ZIP and verifies its SHA-256 checksum. Configure Google Cloud credentials in your private Gloss config directory and keep AnkiConnect running.

Python distributions are included for manual installation. See the README for setup and development commands. Studio Feixen Sans is not included; supply your licensed copy privately or use the system font fallback.
