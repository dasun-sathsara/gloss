import { type Card, type Clip, clips } from "../lib";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const fields = [
  ["word", "Word"],
  ["pos", "Part of speech"],
  ["meaning", "English definition"],
  ["sinhala", "Sinhala meaning"],
  ["example1", "Example 1"],
  ["example2", "Example 2"],
] as const;

export function WordEditor({
  card,
  disabled,
  dirty,
  onChange,
  onSave,
  onRetry,
  onListen,
  onClose,
}: {
  card: Card;
  disabled: boolean;
  dirty: boolean;
  onChange: (patch: Partial<Card>) => void;
  onSave: () => void;
  onRetry: () => void;
  onListen: (kind: Clip) => void;
  onClose: () => void;
}) {
  return (
    <section className="word-editor" aria-label={`Edit ${card.word}`}>
      <div className="editor-fields">
        {fields.map(([key, label]) => (
          <Field key={key} className="gap-1.5">
            <FieldLabel htmlFor={`${card.id}-${key}`}>{label}</FieldLabel>
            {key === "word" || key === "pos" ? (
              <Input
                id={`${card.id}-${key}`}
                value={card[key]}
                disabled={disabled}
                maxLength={key === "word" ? 120 : 60}
                onChange={(event) => onChange({ [key]: event.target.value })}
              />
            ) : (
              <Textarea
                id={`${card.id}-${key}`}
                value={card[key]}
                disabled={disabled}
                rows={2}
                maxLength={800}
                className={key === "sinhala" ? "sinhala-input" : ""}
                lang={key === "sinhala" ? "si" : "en"}
                onChange={(event) => onChange({ [key]: event.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      {!card.valid && (
        <Field orientation="horizontal" className="gap-2">
          <Checkbox
            id={`${card.id}-verified`}
            checked={card.valid}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ valid: checked === true })}
          />
          <FieldLabel htmlFor={`${card.id}-verified`}>
            I verified this word and completed its fields.
          </FieldLabel>
        </Field>
      )}
      <section className="editor-audio" aria-label="Audio clips">
        {clips.map((clip, index) => (
          <div key={clip}>
            <span>{["Word", "Definition", "Example 1", "Example 2"][index]}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !card.valid}
              onClick={() => onListen(clip)}
              aria-label={`${card.audio[clip] ? "Play" : "Generate"} ${["word", "definition", "example 1", "example 2"][index]} audio`}
            >
              {card.audio[clip] ? (
                <PlayIcon aria-hidden="true" />
              ) : (
                <WaveformIcon aria-hidden="true" />
              )}
              {card.audio[clip] ? "Play" : "Generate"}
            </Button>
            {card.audio_errors[clip] && (
              <p role="alert" className="text-destructive">
                {card.audio_errors[clip]}
              </p>
            )}
          </div>
        ))}
      </section>
      <div className="editor-footer">
        <span className="save-state" role="status" data-dirty={dirty}>
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
        <Button size="sm" disabled={disabled || !dirty} onClick={onSave}>
          Save changes
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onRetry}>
          Regenerate
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close editor
        </Button>
      </div>
    </section>
  );
}

import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { WaveformIcon } from "@phosphor-icons/react/dist/csr/Waveform";
