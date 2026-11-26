import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { Choice } from "./components/Choice";
import { ManualBatch, ManualStart } from "./components/ManualGeneration";
import { Modal } from "./components/Modal";
import { Settings } from "./components/Settings";
import { Spinner } from "./components/Spinner";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Field, FieldLabel } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Textarea } from "./components/ui/textarea";
import { WordTable } from "./components/WordTable";
import { useGloss } from "./hooks/useGloss";
import {
  api,
  audioSetupHint,
  type Card,
  type Decision,
  type Job,
  isReady,
  normalizedText,
} from "./lib";

export default function App() {
  const g = useGloss();
  const b = g.bootstrap;
  if (!b)
    return (
      <main className="loading-screen" role="status" aria-live="polite">
        {g.error ? (
          g.error
        ) : (
          <>
            <Spinner />
            <span>Opening Gloss…</span>
          </>
        )}
      </main>
    );
  const audioReady = b.audio_ready;
  // Local audio is free, so a batch that costs words only should not quote dollars.
  const costNote = !audioReady
    ? "Gloss will add the words without audio."
    : b.audio_provider === "woof"
      ? "Woof records audio on your computer at no cost."
      : `Estimated cost with audio: $${(g.parsed?.estimate_usd ?? 0).toFixed(2)}.`;
  const parent = `${b.settings.deck_parent}::`;
  const names = g.anki.connected
    ? g.anki.decks
    : [
        ...new Set([
          `${parent}${b.settings.deck_default}`,
          ...b.settings.seed_decks.map((name) => `${parent}${name}`),
          ...g.cards.map((card) => card.deck),
        ]),
      ].filter((name) => name.startsWith(parent));
  const deckMissing = g.anki.connected && !names.includes(g.deck);
  const options = [...new Set([g.deck, ...names])].filter(Boolean).map((value) => ({
    value,
    label: value.startsWith(parent) ? value.slice(parent.length).replaceAll("::", " / ") : value,
    disabled: g.anki.connected && !names.includes(value),
  }));
  const readyDecks = [...new Set(g.readySelection.map((card) => card.deck))];
  const hasCards = g.view === "library" ? g.cards.length > 0 : g.batchIds.size > 0;
  const recovery = g.recovery;
  const remaining = recovery
    ? g.cards.filter(
        (card) =>
          recovery.ids.includes(card.id) &&
          (g.view === "library" || g.batchIds.has(card.id)) &&
          card.decision !== "skip",
      )
    : [];
  const recoveryProfileChanged =
    !!recovery && !!g.anki.connected && recovery.profile !== g.anki.profile;
  const retryCards = remaining.filter(isReady);
  const selectedForRecovery = g.readySelection.some((card) => recovery?.ids.includes(card.id));
  const recoveryDeckChanged =
    !!recovery &&
    retryCards.some(
      (card) => card.deck !== recovery.decks[card.id] || !g.anki.decks.includes(card.deck),
    );
  const hiddenCount =
    g.selected.size - g.visibleCards.filter((card) => g.selected.has(card.id)).length;
  return (
    <div className="app-shell">
      <a className="skip-workspace" href="#gloss-workspace">
        Skip to workspace
      </a>
      <header className="app-header">
        <a href="/" className="brand">
          <img src="/favicon.svg" alt="" className="brand-mark" width={28} height={28} />
          Gloss
        </a>
        <Tabs value={g.view} onValueChange={(value) => g.changeView(value as "review" | "library")}>
          <TabsList aria-label="Workspace" className="workspace-tabs" data-view={g.view}>
            <span className="workspace-tab-indicator" aria-hidden="true" />
            <TabsTrigger value="review">Batch</TabsTrigger>
            <TabsTrigger value="library">Library</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="header-actions">
          <Button
            variant="ghost"
            onClick={() => {
              g.setError("");
              g.setSetupOpen(true);
            }}
            disabled={g.busy}
            className="anki-indicator"
            data-anki-ready={g.anki.ready}
          >
            Anki {g.anki.connected ? (g.anki.ready ? "connected" : "setup needed") : "offline"}
          </Button>
          <Button
            variant="ghost"
            disabled={g.busy}
            onClick={() => {
              g.setError("");
              g.setSettingsOpen(true);
            }}
          >
            <GearSixIcon aria-hidden="true" />
            Settings
          </Button>
        </div>
      </header>
      <main id="gloss-workspace" className="workspace" tabIndex={-1}>
        {b.demo && (
          <p className="demo-notice">Offline demo with sample definitions and test tones</p>
        )}
        {b.library_truncated && (
          <Alert>
            <AlertDescription>
              <p>
                Showing the newest {g.cards.length} of {b.card_count} saved words.
              </p>
            </AlertDescription>
          </Alert>
        )}
        {g.error && (
          <Alert variant="destructive" className="message">
            <AlertDescription>{g.error}</AlertDescription>
            <Button variant="ghost" size="sm" onClick={() => g.setError("")}>
              Dismiss
            </Button>
          </Alert>
        )}
        {g.notice && (
          <div className="message notice" role="status">
            <span>{g.notice}</span>
            <Button variant="ghost" size="sm" onClick={() => g.setNotice("")}>
              Dismiss
            </Button>
          </div>
        )}
        <div className={g.view === "review" ? "batch-layout" : "library-layout"}>
          {g.view === "review" && (
            <section className="composer" aria-labelledby="add-heading">
              <div className="section-heading">
                <h1 id="add-heading">Add words</h1>
              </div>
              <Choice
                label="Deck"
                value={g.deck}
                options={options}
                onChange={g.chooseDeck}
                disabled={g.busy || !!g.manual}
                id="batch-deck"
              />
              {deckMissing && (
                <p className="text-destructive help">
                  This deck is missing in Anki. Choose an existing subdeck.
                </p>
              )}
              {g.manual ? (
                <ManualBatch
                  key={g.manual.code}
                  run={g.manual}
                  busy={g.busy}
                  error={g.manualError}
                  focusCopy={g.manual.code === g.nextCopyCode}
                  onImport={g.importManual}
                  onClose={g.closeManual}
                />
              ) : (
                <>
                  <div className="word-input-group">
                    <Field className="gap-1.5">
                      <FieldLabel htmlFor="words-input">Words</FieldLabel>
                      <Textarea
                        id="words-input"
                        placeholder={"curious\npatient: willing to wait"}
                        title="Separate entries with line breaks, commas, or semicolons. Put hints after a colon."
                        value={g.text}
                        onChange={(event) => g.setText(event.target.value)}
                        disabled={g.busy}
                        maxLength={20000}
                        rows={8}
                        onKeyDown={(event) => {
                          if (
                            (event.ctrlKey || event.metaKey) &&
                            event.key === "Enter" &&
                            g.parsed?.count &&
                            !g.busy &&
                            g.generationMode === "api" &&
                            b.provider_ready &&
                            g.deck &&
                            !deckMissing
                          ) {
                            event.preventDefault();
                            void g.generate();
                          }
                        }}
                      />
                    </Field>
                    {g.generationMode === "api" &&
                      b.text_provider === "endpoint" &&
                      b.text_health !== "off" && (
                        <p className={`endpoint-status ${b.text_health}`} role="status">
                          <span className="endpoint-dot" aria-hidden="true" />
                          {b.text_health === "ready"
                            ? "Text provider is ready"
                            : b.text_health === "warming"
                              ? "Connecting to the text provider"
                              : b.text_health_detail || "Could not reach the text provider"}
                        </p>
                      )}
                    {g.parsed && (
                      <div className="estimate" role="status">
                        <span>
                          {g.parsed.count} {g.parsed.count === 1 ? "word" : "words"}
                        </span>
                        {g.generationMode === "api" &&
                          audioReady &&
                          b.audio_provider === "google" && (
                            <span>~${g.parsed.estimate_usd.toFixed(2)} USD with audio</span>
                          )}
                      </div>
                    )}
                    {(() => {
                      const issues =
                        g.parsed?.entries.filter((entry) => entry.duplicate || entry.warning) ?? [];
                      if (!issues.length) return null;
                      return (
                        <>
                          {issues.some((entry) => entry.duplicate) && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={g.busy}
                              onClick={() =>
                                g.setText(
                                  g
                                    .parsed!.entries.filter((entry) => !entry.duplicate)
                                    .map(
                                      (entry) => entry.word + (entry.hint ? ": " + entry.hint : ""),
                                    )
                                    .join("\n"),
                                )
                              }
                            >
                              Remove duplicates
                            </Button>
                          )}
                          {issues.slice(0, 5).map((entry) => {
                            const label = entry.word
                              ? `${entry.word.slice(0, 40)}${entry.word.length > 40 ? "…" : ""}: `
                              : "";
                            return (
                              <p className="help" key={entry.index}>
                                {label}
                                {entry.warning || "Duplicate entry"}
                              </p>
                            );
                          })}
                          {issues.length > 5 && (
                            <p className="help">+{issues.length - 5} more warnings or duplicates</p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  {g.generationMode === "manual" ? (
                    <ManualStart
                      size={b.settings.manual_batch_size}
                      wordCount={g.parsed?.count ?? 0}
                      busy={g.busy}
                      disabled={!g.parsed?.count || !g.deck || deckMissing}
                      onStart={g.startManual}
                    />
                  ) : (
                    <Button
                      className="generate-button"
                      disabled={
                        g.busy || !g.parsed?.count || !b.provider_ready || !g.deck || deckMissing
                      }
                      aria-busy={g.job?.kind === "text" || undefined}
                      onClick={() => g.generate()}
                    >
                      {g.job?.kind === "text" && <Spinner />}
                      {g.job?.kind === "text" ? "Generating…" : "Generate"}
                    </Button>
                  )}
                </>
              )}
            </section>
          )}
          <section className="review-section" aria-labelledby="review-heading">
            <div className="review-heading">
              <h2 id="review-heading">
                {g.view === "review" ? "Words" : "Library"}
                <span className="word-count">{g.visibleCards.length}</span>
              </h2>
              {hasCards && (
                <Input
                  className="search"
                  aria-label="Search words"
                  placeholder="Search words"
                  value={g.search}
                  onChange={(event) => g.setSearch(event.target.value)}
                />
              )}
            </div>
            {hasCards && (
              <>
                {hiddenCount > 0 && (
                  <div className="selection-warning">
                    <span>
                      This filter hides {hiddenCount} selected{" "}
                      {hiddenCount === 1 ? "card" : "cards"}. Actions still include them.
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={g.busy}
                      onClick={() => g.setSelected(new Set(g.visibleCards.map((card) => card.id)))}
                    >
                      Select visible only
                    </Button>
                  </div>
                )}
                <div className="review-toolbar">
                  <span className="selection-count">{g.selected.size} selected</span>
                  <div className="bulk-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={g.busy || !g.missingCount || !audioReady}
                      title={
                        !audioReady
                          ? audioSetupHint(b.audio_provider)
                          : g.readySelection.length && !g.missingCount
                            ? "The selected cards already have audio."
                            : undefined
                      }
                      className="batch-action"
                      onClick={g.audio}
                    >
                      Prepare audio
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        g.busy ||
                        !g.readySelection.length ||
                        selectedForRecovery ||
                        !g.anki.ready ||
                        (g.view === "review" && deckMissing)
                      }
                      title={
                        selectedForRecovery
                          ? "Use Retry remaining cards to finish saving to Anki."
                          : !g.anki.connected
                            ? "Open Anki with AnkiConnect enabled."
                            : !g.anki.ready
                              ? "Choose Set up Anki in the Anki dialog."
                              : g.view === "review" && deckMissing
                                ? "Choose an existing Anki subdeck before syncing."
                                : undefined
                      }
                      className="batch-action"
                      onClick={() => g.beginSync()}
                    >
                      Sync to Anki
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={g.editLocked || !g.selected.size}
                      onClick={() => g.setRemoveIds([...g.selected])}
                    >
                      Remove selected
                    </Button>
                  </div>
                </div>
                {(g.readySelection.length > 0 || !g.anki.connected) && (
                  <div className="review-meta">
                    {g.readySelection.length > 0 && (
                      <p className="help">
                        {g.readySelection.length} {g.readySelection.length === 1 ? "card" : "cards"}{" "}
                        ready for Anki. {readyDecks.length === 1 ? "Deck" : "Decks"}:{" "}
                        {readyDecks.join(", ")}.
                      </p>
                    )}
                    {!g.anki.connected && (
                      <div>
                        <Button variant="ghost" size="sm" onClick={() => g.setSetupOpen(true)}>
                          Anki help
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {recovery && remaining.length > 0 && (
              <div className="notice message anki-recovery">
                <div>
                  <p>
                    Gloss saved {recovery.saved} {recovery.saved === 1 ? "card" : "cards"} in Anki
                    under {JSON.stringify(recovery.profile)}. Cards left to save:
                  </p>
                  <ul>
                    {remaining.map((card) => (
                      <li key={card.id}>
                        {card.word} in {recovery.decks[card.id]}.
                        {card.id === recovery.ids[0] && " Gloss stopped here."}
                        {!isReady(card) && " Needs edits."}
                      </li>
                    ))}
                  </ul>
                  {recoveryProfileChanged && (
                    <p className="help">
                      Switch to {recovery.profile} in Anki, then choose Refresh in the Anki dialog.
                    </p>
                  )}
                  {!recoveryProfileChanged && g.anki.ready && recoveryDeckChanged && (
                    <p className="help">Restore the original decks before retrying.</p>
                  )}
                </div>
                <Button
                  variant="outline"
                  disabled={
                    g.busy ||
                    !g.anki.ready ||
                    retryCards.length !== remaining.length ||
                    recoveryProfileChanged ||
                    recoveryDeckChanged
                  }
                  onClick={() => g.beginSync(retryCards.map((card) => card.id))}
                >
                  Retry remaining cards
                </Button>
              </div>
            )}
            {g.job && (
              <div
                className="job-status"
                role="status"
                aria-live="polite"
                aria-busy="true"
                data-determinate={g.progress?.total ? true : undefined}
              >
                <span className="job-label">
                  <Spinner className="job-spinner" />
                  <span>
                    {g.job.kind === "sync"
                      ? "Saving notes in Anki…"
                      : g.audioRunning
                        ? "Recording audio…"
                        : "Writing words…"}
                    {g.progress?.total ? ` ${g.progress.completed}/${g.progress.total}` : ""}
                  </span>
                </span>
                {g.job.kind !== "sync" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={g.pending}
                    onClick={() =>
                      g.perform(async () => {
                        await api(`/jobs/${g.job?.id}/cancel`, "POST", {});
                      })
                    }
                  >
                    Cancel
                  </Button>
                )}
                {g.progress?.total ? (
                  <span
                    className="job-progress"
                    aria-hidden="true"
                    style={{ width: `${(100 * g.progress.completed) / g.progress.total}%` }}
                  />
                ) : null}
              </div>
            )}
            {g.visibleCards.length ? (
              <WordTable
                cards={g.visibleCards}
                selected={g.selected}
                dirty={g.dirty}
                disabled={g.busy}
                editDisabled={g.editLocked}
                jobActive={!!g.job}
                audioReady={audioReady}
                audioHelp={audioSetupHint(b.audio_provider)}
                library={g.view === "library"}
                playing={g.playing}
                onSelect={(id) =>
                  g.setSelected((old) => {
                    const next = new Set(old);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onSelectRange={(ids, checked) =>
                  g.setSelected((old) => {
                    const next = new Set(old);
                    for (const id of ids) {
                      if (checked) next.add(id);
                      else next.delete(id);
                    }
                    return next;
                  })
                }
                onSelectAll={(checked) =>
                  g.setSelected((old) => {
                    const next = new Set(old);
                    for (const card of g.visibleCards) {
                      if (checked) next.add(card.id);
                      else next.delete(card.id);
                    }
                    return next;
                  })
                }
                onChange={g.changeCard}
                onSave={(card) =>
                  g.perform(async () => {
                    await g.saveEdit(card);
                  })
                }
                onDiscard={g.discardCard}
                onRemove={(id) => g.setRemoveIds([id])}
                onRetry={g.generationMode === "api" && b.provider_ready ? g.retry : undefined}
                onListen={g.listen}
                onStopAudio={g.stopAudio}
              />
            ) : (
              <p className="empty-state">
                {g.search ? (
                  "No matching words."
                ) : g.job ? (
                  <>
                    <Spinner />
                    <span>Waiting for words…</span>
                  </>
                ) : g.view === "review" ? (
                  "No words in this batch."
                ) : (
                  "No saved words."
                )}
              </p>
            )}
          </section>
        </div>
      </main>
      <Modal title="Settings" open={g.settingsOpen} onOpenChange={g.setSettingsOpen}>
        <Settings
          mode={g.generationMode}
          providerReady={b.provider_ready}
          manualActive={!!g.manual}
          settings={b.settings}
          voices={b.voices}
          woofVoices={b.woof_voices}
          woofDefaultVoice={b.woof_default_voice}
          woofConfigured={b.woof_configured}
          googleAudioAvailable={b.google_audio_available}
          demo={b.demo}
          configDir={b.config_dir}
          anki={g.anki}
          busy={g.busy}
          onSave={async (preferences, mode) => {
            await g.saveSettings(preferences);
            if (mode !== g.generationMode) g.chooseGenerationMode(mode);
          }}
          onAddDeck={async (name) => {
            await api("/anki/decks", "POST", { name });
            await g.refreshAnki();
          }}
        />
      </Modal>
      <Modal title="Anki" open={g.setupOpen} onOpenChange={g.setSetupOpen}>
        {g.error && (
          <Alert variant="destructive" className="message">
            <AlertDescription>{g.error}</AlertDescription>
          </Alert>
        )}
        {!g.anki.connected ? (
          <p>
            Open Anki with the{" "}
            <a
              className="text-link"
              href="https://ankiweb.net/shared/info/2055492159"
              target="_blank"
              rel="noreferrer"
            >
              AnkiConnect add-on
            </a>{" "}
            installed, then refresh.
          </p>
        ) : (
          <p>
            Anki is using the {g.anki.profile} profile. Set up Anki to create the{}
            {b.settings.deck_parent} deck, its subdecks, and the {b.settings.note_type} note type.
          </p>
        )}
        {g.anki.warnings?.map((warning) => (
          <p className="help" key={warning}>
            {warning}
          </p>
        ))}
        {(g.anki.parent_cards || 0) > 0 && (
          <Field orientation="horizontal">
            <Checkbox
              id="move-parent"
              checked={g.moveParent}
              onCheckedChange={(checked) => g.setMoveParent(checked === true)}
            />
            <FieldLabel htmlFor="move-parent">
              Move {g.anki.parent_cards} parent-deck cards into {b.settings.deck_default}
            </FieldLabel>
          </Field>
        )}
        <div className="dialog-footer">
          <Button
            variant="outline"
            disabled={g.busy}
            onClick={() =>
              g.perform(async () => {
                await g.refreshAnki();
              })
            }
          >
            Refresh
          </Button>
          <Button
            disabled={g.busy || !g.anki.connected}
            onClick={() =>
              g.perform(async () => {
                await api("/anki/setup", "POST", { move_parent_cards: g.moveParent });
                await g.refreshAnki();
                g.setSetupOpen(false);
              })
            }
          >
            Set up Anki
          </Button>
        </div>
      </Modal>
      <Modal
        title={g.removeIds.length === 1 ? "Remove this word?" : "Remove these words?"}
        open={g.removeIds.length > 0}
        onOpenChange={(open) => {
          if (!open) g.setRemoveIds([]);
        }}
      >
        <p>
          {g.removeIds.length === 1
            ? `Gloss will delete "${removeLabel(g.cards, g.removeIds[0])}" and its edits.`
            : `Gloss will delete ${g.removeIds.length} words and their edits.`}{" "}
          This does not delete notes from Anki.
        </p>
        <div className="dialog-footer">
          <Button variant="outline" onClick={() => g.setRemoveIds([])}>
            Keep
          </Button>
          <Button
            variant="destructive"
            disabled={g.pending || (g.busy && !g.audioRunning)}
            onClick={() => g.remove(g.removeIds)}
          >
            Remove
          </Button>
        </div>
      </Modal>
      <Modal title="Generate a larger batch?" open={g.confirmCap} onOpenChange={g.setConfirmCap}>
        <p>
          You entered {g.parsed?.count} words. Your word limit is {b.settings.word_cap}. {costNote}
        </p>
        <div className="dialog-footer">
          <Button variant="outline" onClick={() => g.setConfirmCap(false)}>
            Keep editing
          </Button>
          <Button disabled={g.busy} onClick={() => g.generate(true)}>
            Generate
          </Button>
        </div>
      </Modal>
      <Modal
        title="Finish syncing in Anki"
        open={!!g.syncDialog}
        onOpenChange={(open) => {
          if (!open) g.setSyncDialog(null);
        }}
      >
        <p>
          Send {g.syncDialog?.ids.length} {g.syncDialog?.ids.length === 1 ? "card" : "cards"} to{" "}
          {[
            ...new Set(
              g.cards
                .filter((card) => g.syncDialog?.ids.includes(card.id))
                .map((card) => card.deck),
            ),
          ].join(", ")}
          . Wait for Anki to finish syncing the {g.syncDialog?.profile} profile before you save. If
          Anki asks for a full upload or download, finish it there first.
        </p>
        {g.error && (
          <Alert variant="destructive" className="message">
            <AlertDescription>{g.error}</AlertDescription>
          </Alert>
        )}
        {g.missing && (
          <Field orientation="horizontal">
            <Checkbox
              id="allow-missing"
              checked={g.allowMissing}
              onCheckedChange={(checked) => g.setAllowMissing(checked === true)}
            />
            <FieldLabel htmlFor="allow-missing">Save without all audio</FieldLabel>
          </Field>
        )}
        <div className="dialog-footer">
          <Button variant="outline" onClick={() => g.setSyncDialog(null)}>
            Cancel
          </Button>
          <Button
            disabled={g.busy || (g.missing && !g.allowMissing)}
            onClick={() =>
              g.perform(async () => {
                if (!g.syncDialog) return;
                g.setJob(
                  await api<Job>("/anki/sync", "POST", {
                    ...g.syncDialog,
                    allow_missing: g.allowMissing,
                  }),
                );
                g.setSyncDialog(null);
              })
            }
          >
            Save notes to Anki
          </Button>
        </div>
      </Modal>
      <Modal
        title="Resolve duplicate meanings"
        open={g.conflicts.length > 0}
        onOpenChange={(open) => {
          if (!open) g.setConflicts([]);
        }}
      >
        {g.error && (
          <Alert variant="destructive" className="message">
            <AlertDescription>{g.error}</AlertDescription>
          </Alert>
        )}
        {(() => {
          const grouped = new Map<
            string,
            {
              id: string;
              word: string;
              ankiNotes: Record<string, string>[];
              batchNotes: Record<string, string>[];
            }
          >();
          for (const conflict of g.conflicts) {
            const entry = grouped.get(conflict.id) ?? {
              id: conflict.id,
              word: conflict.word,
              ankiNotes: [],
              batchNotes: [],
            };
            if (conflict.kind === "anki") entry.ankiNotes.push(...conflict.existing);
            else entry.batchNotes.push(...conflict.existing);
            grouped.set(conflict.id, entry);
          }
          const groups = [...grouped.values()];
          const keyCounts = new Map<string, number>();
          for (const card of g.cards.filter(
            (card) => g.syncIds.includes(card.id) && isReady(card) && card.decision !== "skip",
          )) {
            if (card.decision === "keep_both") continue;
            const key = `${normalizedText(card.word)}\0${normalizedText(card.pos)}`;
            keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
          }
          const hasUnresolvedBatchCollision = [...keyCounts.values()].some((count) => count > 1);
          const hasUnpicked = groups.some(
            (group) => g.cards.find((card) => card.id === group.id)?.decision === "ask",
          );
          return (
            <>
              <div className="conflict-list">
                {groups.map((group) => {
                  const card = g.cards.find((item) => item.id === group.id);
                  const choiceOptions = [
                    { value: "ask", label: "Choose an action" },
                    { value: "keep_both", label: "Keep both meanings" },
                    ...(group.ankiNotes.length
                      ? [{ value: "overwrite", label: "Overwrite existing meaning" }]
                      : []),
                    { value: "skip", label: "Skip this word" },
                  ];
                  return (
                    <div key={group.id}>
                      <h3>{group.word}</h3>
                      <p>New: {card?.meaning}</p>
                      {group.ankiNotes.map((note) => (
                        <p className="help" key={`anki-${JSON.stringify(note)}`}>
                          In Anki: {note["English Meaning"]}
                        </p>
                      ))}
                      {group.batchNotes.map((note) => (
                        <p className="help" key={`batch-${JSON.stringify(note)}`}>
                          Also in this batch: {note["English Meaning"]}
                        </p>
                      ))}
                      <Choice
                        label={`Action for ${group.word}`}
                        value={card?.decision || "ask"}
                        onChange={(value) =>
                          g.changeCard(group.id, { decision: value as Decision })
                        }
                        options={choiceOptions}
                      />
                    </div>
                  );
                })}
              </div>
              {hasUnresolvedBatchCollision && (
                <p className="text-destructive help">
                  These words still point to the same Anki note. For at least one word, choose Keep
                  both meanings or Skip this word.
                </p>
              )}
              <div className="dialog-footer">
                <Button
                  disabled={g.busy || hasUnpicked || hasUnresolvedBatchCollision}
                  onClick={g.resolveConflicts}
                >
                  Save choices
                </Button>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}

function removeLabel(cards: Card[], id: string | undefined) {
  const card = cards.find((value) => value.id === id);
  return card?.word || card?.source_word || "This word";
}
