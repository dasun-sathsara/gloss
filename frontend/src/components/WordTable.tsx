import { Fragment, useId, useRef, useState } from "react";
import { type Card, type Clip, clips, isReady } from "../lib";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { WordEditor } from "./WordEditor";

function AnkiStatus({ card, dirty }: { card: Card; dirty: boolean }) {
  if (dirty) return <span className="draft-label unsaved-label">Unsaved</span>;
  if (card.decision === "skip") return <span className="draft-label">Skipped</span>;
  if (card.note_id && card.synced_hash) {
    return (
      <Badge variant="secondary" className="synced-label">
        In Anki
      </Badge>
    );
  }
  if (card.note_id) {
    return (
      <Badge variant="secondary" className="synced-label">
        Edited
      </Badge>
    );
  }
  return <span className="draft-label">Draft</span>;
}

const clipNames: Record<Clip, string> = {
  word: "Word",
  meaning: "Definition",
  example1: "Example 1",
  example2: "Example 2",
};

function AudioCell({ card }: { card: Card }) {
  const ready = clips.filter((clip) => card.audio[clip]).length;
  const failed = clips.filter((clip) => !card.audio[clip] && card.audio_errors[clip]);
  const problem = failed.map((clip) => `${clipNames[clip]}: ${card.audio_errors[clip]}`).join("\n");
  return (
    <TableCell className="audio-column" title={problem || undefined}>
      <span
        className="audio-count"
        data-complete={ready === clips.length || undefined}
        data-failed={failed.length > 0 || undefined}
        aria-hidden="true"
      >
        {ready}/4
      </span>
      <span className="audio-meter" aria-hidden="true">
        {clips.map((clip) => (
          <span
            key={clip}
            data-ready={!!card.audio[clip]}
            data-failed={(!card.audio[clip] && !!card.audio_errors[clip]) || undefined}
          />
        ))}
      </span>
      <span className="sr-only">
        {ready} of 4 audio clips
        {failed.length ? `. ${failed.length} failed. Open the editor to see why.` : ""}
      </span>
    </TableCell>
  );
}

export function WordTable({
  cards,
  selected,
  dirty,
  disabled,
  editDisabled,
  jobActive,
  audioReady,
  library,
  playing,
  onSelect,
  onSelectRange,
  onSelectAll,
  onChange,
  onSave,
  onDiscard,
  onRemove,
  onRetry,
  onListen,
  onStopAudio,
}: {
  cards: Card[];
  selected: Set<string>;
  dirty: Set<string>;
  disabled: boolean;
  editDisabled: boolean;
  jobActive: boolean;
  audioReady: boolean;
  library: boolean;
  playing: { id: string; kind: Clip } | null;
  onSelect: (id: string) => void;
  onSelectRange?: (ids: string[], checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onChange: (id: string, patch: Partial<Card>) => void;
  onSave: (card: Card) => void;
  onDiscard: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: (card: Card) => void;
  onListen: (card: Card, kind: Clip) => void;
  onStopAudio: () => void;
}) {
  const selectAllId = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const lastToggledId = useRef<string | null>(null);
  const shiftHeld = useRef(false);
  const activeEditing = cards.some((card) => card.id === editing) ? editing : null;
  const all = cards.length > 0 && cards.every((card) => selected.has(card.id));
  const some = cards.some((card) => selected.has(card.id));
  return (
    <Table className="word-table">
      <TableHeader>
        <TableRow>
          <TableHead className="check-column">
            <label className="check-target" htmlFor={selectAllId}>
              <Checkbox
                id={selectAllId}
                aria-label="Select all words"
                disabled={disabled || !cards.length}
                checked={all ? true : some ? "indeterminate" : false}
                onCheckedChange={(checked) => onSelectAll(checked === true)}
              />
            </label>
          </TableHead>
          <TableHead className="word-column">Word</TableHead>
          <TableHead>Meaning</TableHead>
          <TableHead className="audio-column">Audio</TableHead>
          <TableHead className="status-column">Status</TableHead>
          <TableHead className="actions-column">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map((card, index) => {
          const isDirty = dirty.has(card.id);
          const isEditing = activeEditing === card.id;
          const label = card.word || card.source_word || "word";
          return (
            <Fragment key={card.id}>
              <TableRow
                className="word-row"
                data-state={selected.has(card.id) ? "selected" : undefined}
                data-word-id={card.id}
                data-editing={isEditing || undefined}
              >
                <TableCell className="check-column">
                  <label className="check-target" htmlFor={`select-${card.id}`}>
                    <Checkbox
                      id={`select-${card.id}`}
                      aria-label={`Select ${label}`}
                      checked={selected.has(card.id)}
                      disabled={disabled}
                      onClick={(event) => {
                        shiftHeld.current = event.shiftKey;
                      }}
                      onCheckedChange={(checked) => {
                        const nextChecked = checked === true;
                        const anchor = lastToggledId.current
                          ? cards.findIndex((item) => item.id === lastToggledId.current)
                          : -1;
                        if (
                          shiftHeld.current &&
                          onSelectRange &&
                          anchor !== -1 &&
                          anchor !== index
                        ) {
                          const start = Math.min(anchor, index);
                          const end = Math.max(anchor, index);
                          onSelectRange(
                            cards.slice(start, end + 1).map((item) => item.id),
                            nextChecked,
                          );
                        } else {
                          onSelect(card.id);
                        }
                        lastToggledId.current = card.id;
                        shiftHeld.current = false;
                      }}
                    />
                  </label>
                </TableCell>
                <TableCell className="word-column">
                  <span className="word-name">{card.word || card.source_word}</span>
                  {card.pos && <span className="word-pos">{card.pos}</span>}
                  {library && (
                    <span className="word-deck">{card.deck.split("::").slice(1).join(" / ")}</span>
                  )}
                </TableCell>
                <TableCell className="meaning-column">
                  {isReady(card) ? (
                    <>
                      <p className="definition">{card.meaning}</p>
                      <p className="sinhala" lang="si">
                        {card.sinhala}
                      </p>
                    </>
                  ) : (
                    <p className="invalid-word">
                      {card.reason || "Complete the fields before syncing."}
                    </p>
                  )}
                </TableCell>
                <AudioCell card={card} />
                <TableCell className="status-column">
                  <AnkiStatus card={card} dirty={isDirty} />
                </TableCell>
                <TableCell className="actions-column">
                  <div className="row-actions">
                    <span className="mobile-note-status">
                      <AnkiStatus card={card} dirty={isDirty} />
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={editDisabled}
                      onClick={() => {
                        if (isEditing && playing?.id === card.id) onStopAudio();
                        setEditing(isEditing ? null : card.id);
                      }}
                      aria-expanded={isEditing}
                      aria-controls={`editor-${card.id}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={editDisabled}
                      onClick={() => onRemove(card.id)}
                      className="remove-word"
                    >
                      Remove
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              {isEditing && (
                <TableRow id={`editor-${card.id}`} className="editor-row">
                  <TableCell colSpan={6}>
                    <WordEditor
                      card={card}
                      dirty={isDirty}
                      disabled={editDisabled}
                      jobActive={jobActive}
                      audioReady={audioReady}
                      playingClip={playing?.id === card.id ? playing.kind : null}
                      onChange={(patch) => onChange(card.id, patch)}
                      onSave={() => onSave(card)}
                      onDiscard={() => onDiscard(card.id)}
                      onRetry={() => onRetry(card)}
                      onListen={(kind) => onListen(card, kind)}
                      onClose={() => {
                        if (playing?.id === card.id) onStopAudio();
                        setEditing(null);
                      }}
                    />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
