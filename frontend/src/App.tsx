import { Choice } from "./components/Choice";
import { Modal } from "./components/Modal";
import { Settings } from "./components/Settings";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { Field, FieldLabel } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Textarea } from "./components/ui/textarea";
import { WordTable } from "./components/WordTable";
import { useGloss } from "./hooks/useGloss";
import { api, type Decision, type Job } from "./lib";

export default function App() {
  const g = useGloss();
  const b = g.bootstrap;
  if (!b)
    return (
      <main className="loading-screen" role="status">
        {g.error || "Opening Gloss…"}
      </main>
    );
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
  return (
    <div className="app-shell">
      <header className="app-header">
        <a href="/" className="brand">
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
          >
            Anki {g.anki.connected ? "connected" : "offline"}
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
      <main className="workspace">
        {b.demo && <p className="demo-notice">Offline demo · Sample definitions and test tones</p>}
        {b.library_truncated && (
          <Alert>
            <AlertDescription>
              Showing the newest {g.cards.length} of {b.card_count} saved words.
            </AlertDescription>
          </Alert>
        )}
        {!b.provider_ready && (
          <Alert>
            <AlertDescription>
              Add the Google project and service-account credentials in <code>{b.config_dir}</code>,
              then restart Gloss.
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
                disabled={g.busy}
                id="batch-deck"
              />
              {deckMissing && (
                <p className="text-destructive help">
                  This deck is missing in Anki. Choose an existing subdeck.
                </p>
              )}
              <div className="word-input-group">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="words-input">Words</FieldLabel>
                  <Textarea
                    id="words-input"
                    placeholder={"curious\nresilient\nrecord: a written account"}
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
                        b.provider_ready &&
                        !deckMissing
                      ) {
                        event.preventDefault();
                        g.generate();
                      }
                    }}
                  />
                </Field>
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="format-trigger">
                      Input format
                      <CaretDownIcon aria-hidden="true" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="help">
                      Separate words with new lines, commas, or semicolons. Add context as{" "}
                      <code>word: hint</code>.
                    </p>
                  </CollapsibleContent>
                </Collapsible>
                {g.parsed && (
                  <div className="estimate" role="status">
                    <span>
                      {g.parsed.count} {g.parsed.count === 1 ? "word" : "words"}
                    </span>
                    <span>~${g.parsed.estimate_usd.toFixed(2)} with audio</span>
                  </div>
                )}
                {g.parsed?.entries
                  .filter((entry) => entry.duplicate || entry.warning)
                  .map((entry) => (
                    <p className="help" key={entry.index}>
                      {entry.word}: {entry.warning || "Repeated in this batch"}
                    </p>
                  ))}
              </div>
              <Button
                className="generate-button"
                disabled={g.busy || !g.parsed?.count || !b.provider_ready || !g.deck || deckMissing}
                onClick={() => g.generate()}
              >
                {g.job?.kind === "text" ? "Generating…" : "Generate"}
              </Button>
            </section>
          )}
          <section className="review-section" aria-labelledby="review-heading">
            <div className="review-heading">
              <h2 id="review-heading">
                {g.view === "review" ? "Words" : "Library"}
                <span className="word-count">{g.visibleCards.length}</span>
              </h2>
              <Input
                className="search"
                aria-label="Search words"
                placeholder="Search words"
                value={g.search}
                onChange={(event) => g.setSearch(event.target.value)}
              />
            </div>
            <div className="review-toolbar">
              <span className="selection-count">{g.selected.size} selected</span>
              <div className="bulk-actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={g.busy || !g.readySelection.length}
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
                    !g.anki.ready ||
                    (g.view === "review" && deckMissing)
                  }
                  className="batch-action"
                  onClick={g.beginSync}
                >
                  Sync to Anki
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={g.busy || !g.selected.size}
                  onClick={() => g.remove([...g.selected])}
                >
                  Remove selected
                </Button>
              </div>
            </div>
            {g.job && (
              <div className="job-status" role="status" aria-live="polite">
                <span>
                  {g.job.kind === "text"
                    ? "Generating words…"
                    : g.job.kind === "audio"
                      ? "Preparing audio…"
                      : "Saving notes in Anki…"}
                  {g.progress ? ` ${g.progress.completed}/${g.progress.total}` : ""}
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
              </div>
            )}
            {g.visibleCards.length ? (
              <WordTable
                cards={g.visibleCards}
                selected={g.selected}
                dirty={g.dirty}
                disabled={g.busy}
                library={g.view === "library"}
                onSelect={(id) =>
                  g.setSelected((old) => {
                    const next = new Set(old);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
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
                    await g.saveCard(card);
                  })
                }
                onRemove={(id) => g.remove([id])}
                onRetry={g.retry}
                onListen={g.listen}
              />
            ) : (
              <p className="empty-state">
                {g.search
                  ? "No matching words."
                  : g.job
                    ? "Waiting for words…"
                    : g.view === "review"
                      ? "No words in this batch."
                      : "No saved words."}
              </p>
            )}
          </section>
        </div>
      </main>
      <Modal title="Settings" open={g.settingsOpen} onOpenChange={g.setSettingsOpen}>
        <Settings
          settings={b.settings}
          voices={b.voices}
          configDir={b.config_dir}
          anki={g.anki}
          busy={g.busy}
          onSave={g.saveSettings}
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
            Profile: {g.anki.profile}. Setup creates {b.settings.deck_parent} and its starting
            subdecks, and installs the {b.settings.note_type} note type.
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
        {!b.fonts_complete && (
          <p className="help">Add your licensed Studio Feixen Sans font to use it in Anki.</p>
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
      <Modal title="Generate a larger batch?" open={g.confirmCap} onOpenChange={g.setConfirmCap}>
        <p>
          {g.parsed?.count} words exceeds your cap of {b.settings.word_cap}. Estimated cost with
          audio: ${g.parsed?.estimate_usd.toFixed(2)}.
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
          Wait for syncing to finish in profile {g.syncDialog?.profile}. Resolve any full upload or
          download prompt in Anki before continuing.
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
            <FieldLabel htmlFor="allow-missing">Sync with missing audio</FieldLabel>
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
            Sync finished · Save notes
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
        <div className="conflict-list">
          {g.conflicts.map((conflict) => {
            const card = g.cards.find((card) => card.id === conflict.id);
            return (
              <div key={`${conflict.id}-${conflict.kind}`}>
                <h3>{conflict.word}</h3>
                <p>New: {card?.meaning}</p>
                {conflict.existing.map((note) => (
                  <p className="help" key={JSON.stringify(note)}>
                    Existing: {note["English Meaning"]}
                  </p>
                ))}
                <Choice
                  label={`Action for ${conflict.word}`}
                  value={card?.decision || "ask"}
                  onChange={(value) => g.changeCard(conflict.id, { decision: value as Decision })}
                  options={[
                    { value: "ask", label: "Choose an action" },
                    { value: "keep_both", label: "Keep both meanings" },
                    { value: "overwrite", label: "Overwrite existing meaning" },
                    { value: "skip", label: "Skip this word" },
                  ]}
                />
              </div>
            );
          })}
        </div>
        <div className="dialog-footer">
          <Button
            disabled={
              g.busy ||
              g.conflicts.some(
                (conflict) => g.cards.find((card) => card.id === conflict.id)?.decision === "ask",
              )
            }
            onClick={() =>
              g.perform(async () => {
                await g.flush();
                g.setConflicts([]);
                g.setNotice("Choices saved. Sync to Anki to continue.");
              })
            }
          >
            Save choices
          </Button>
        </div>
      </Modal>
    </div>
  );
}

import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
