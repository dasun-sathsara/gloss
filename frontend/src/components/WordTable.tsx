import { Fragment, useId, useState } from "react";
import { type Card, type Clip, clips } from "../lib";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { WordEditor } from "./WordEditor";

export function WordTable({
  cards,
  selected,
  dirty,
  disabled,
  library,
  onSelect,
  onSelectAll,
  onChange,
  onSave,
  onRemove,
  onRetry,
  onListen,
}: {
  cards: Card[];
  selected: Set<string>;
  dirty: Set<string>;
  disabled: boolean;
  library: boolean;
  onSelect: (id: string) => void;
  onSelectAll: (checked: boolean) => void;
  onChange: (id: string, patch: Partial<Card>) => void;
  onSave: (card: Card) => void;
  onRemove: (id: string) => void;
  onRetry: (card: Card) => void;
  onListen: (card: Card, kind: Clip) => void;
}) {
  const selectAllId = useId();
  const [editing, setEditing] = useState<string | null>(null);
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
          <TableHead className="actions-column">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map((card) => (
          <Fragment key={card.id}>
            <TableRow
              className="word-row"
              data-state={selected.has(card.id) ? "selected" : undefined}
              data-word-id={card.id}
              data-editing={editing === card.id || undefined}
            >
              <TableCell className="check-column">
                <label className="check-target" htmlFor={`select-${card.id}`}>
                  <Checkbox
                    id={`select-${card.id}`}
                    aria-label={`Select ${card.word}`}
                    checked={selected.has(card.id)}
                    disabled={disabled}
                    onCheckedChange={() => onSelect(card.id)}
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
                {card.valid ? (
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
              <TableCell className="audio-column">
                <span
                  className="audio-count"
                  data-complete={clips.every((clip) => card.audio[clip]) || undefined}
                  aria-hidden="true"
                >
                  {clips.filter((clip) => card.audio[clip]).length}/4
                </span>
                <span className="audio-meter" aria-hidden="true">
                  {clips.map((clip) => (
                    <span key={clip} data-ready={!!card.audio[clip]} />
                  ))}
                </span>
                <span className="sr-only">
                  {clips.filter((clip) => card.audio[clip]).length} of 4 audio clips
                </span>
                {card.note_id && <span className="synced-label">In Anki</span>}
              </TableCell>
              <TableCell className="actions-column">
                <div className="row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => setEditing(editing === card.id ? null : card.id)}
                    aria-expanded={editing === card.id}
                    aria-controls={`editor-${card.id}`}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onRemove(card.id)}
                    className="remove-word"
                  >
                    Remove
                  </Button>
                </div>
              </TableCell>
            </TableRow>
            {editing === card.id && (
              <TableRow id={`editor-${card.id}`} className="editor-row">
                <TableCell colSpan={5}>
                  <WordEditor
                    card={card}
                    dirty={dirty.has(card.id)}
                    disabled={disabled}
                    onChange={(patch) => onChange(card.id, patch)}
                    onSave={() => onSave(card)}
                    onRetry={() => onRetry(card)}
                    onListen={(kind) => onListen(card, kind)}
                    onClose={() => setEditing(null)}
                  />
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
