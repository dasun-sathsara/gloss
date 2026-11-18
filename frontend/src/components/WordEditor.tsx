import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { StopIcon } from "@phosphor-icons/react/dist/csr/Stop";
import { WaveformIcon } from "@phosphor-icons/react/dist/csr/Waveform";
import { useEffect, useState } from "react";
import { type Card, type Clip, clips, type Decision, isReady } from "../lib";
import { Choice } from "./Choice";
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
  jobActive,
  audioReady,
  dirty,
  playingClip,
  onChange,
  onSave,
  onDiscard,
  onRetry,
  onListen,
  onClose,
}: {
  card: Card;
  disabled: boolean;
  jobActive: boolean;
  audioReady: boolean;
  dirty: boolean;
  playingClip: Clip | null;
  onChange: (patch: Partial<Card>) => void;
  onSave: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onListen: (kind: Clip) => void;
  onClose: () => void;
}) {
  const [showVerify, setShowVerify] = useState(() => !card.valid);
  const [showDecision, setShowDecision] = useState(() => card.decision !== "ask");
  useEffect(() => {
    if (!card.valid) setShowVerify(true);
  }, [card.valid]);
  useEffect(() => {
    if (card.decision !== "ask") setShowDecision(true);
  }, [card.decision]);
  const label = card.word || card.source_word || "word";
  const ready = isReady(card);
  return (
    <section
      className="word-editor"
      aria-label={`Edit ${label}`}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          (event.key.toLowerCase() === "s" || event.key === "Enter")
        ) {
          if (!disabled && dirty) {
            event.preventDefault();
            onSave();
          }
          return;
        }
        if (
          event.key === "Escape" &&
          !dirty &&
          !(
            event.target instanceof HTMLElement &&
            event.target.getAttribute("role") === "combobox" &&
            event.target.getAttribute("aria-expanded") === "true"
          )
        ) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="editor-fields">
        {fields.map(([key, fieldLabel]) => (
          <Field key={key} className="gap-1.5">
            <FieldLabel htmlFor={`${card.id}-${key}`}>{fieldLabel}</FieldLabel>
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
      {showVerify && (
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
      {card.valid && !ready && (
        <p className="help">
          Complete all word, definition, and example fields before generating audio or syncing.
        </p>
      )}
      {(showDecision || card.decision !== "ask") && (
        <Choice
          label="Duplicate handling"
          value={card.decision}
          disabled={disabled}
          id={`${card.id}-decision`}
          onChange={(value) => onChange({ decision: value as Decision })}
          options={[
            { value: "ask", label: "Ask when syncing" },
            { value: "keep_both", label: "Keep both meanings" },
            { value: "overwrite", label: "Overwrite existing meaning" },
            { value: "skip", label: "Skip this word" },
          ]}
        />
      )}
      <section className="editor-audio" aria-label="Audio clips">
        {clips.map((clip, index) => {
          const hasClip = !!card.audio[clip];
          const isPlaying = hasClip && playingClip === clip;
          const clipName = ["word", "definition", "example 1", "example 2"][index];
          return (
            <div key={clip}>
              <span>{["Word", "Definition", "Example 1", "Example 2"][index]}</span>
              <Button
                variant="outline"
                size="sm"
                // Playing is always fine. Recording a clip starts a run, so it waits.
                disabled={hasClip ? false : disabled || !ready || jobActive || !audioReady}
                title={
                  !hasClip && !audioReady
                    ? "Audio needs Google Cloud credentials or a local Woof model."
                    : !hasClip && !ready
                      ? "Complete all word, definition, and example fields before generating audio."
                      : undefined
                }
                aria-pressed={hasClip ? isPlaying : undefined}
                onClick={() => onListen(clip)}
                aria-label={`${isPlaying ? "Stop" : hasClip ? "Play" : "Generate"} ${clipName} audio`}
              >
                {isPlaying ? (
                  <StopIcon aria-hidden="true" />
                ) : hasClip ? (
                  <PlayIcon aria-hidden="true" />
                ) : (
                  <WaveformIcon aria-hidden="true" />
                )}
                {isPlaying ? "Stop" : hasClip ? "Play" : "Generate"}
              </Button>
              {card.audio_errors[clip] && (
                <p role="alert" className="text-destructive">
                  {card.audio_errors[clip]}
                </p>
              )}
            </div>
          );
        })}
      </section>
      <div className="editor-footer">
        <span className="save-state" role="status" data-dirty={dirty}>
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
        {dirty && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onDiscard}>
            Discard
          </Button>
        )}
        <Button size="sm" disabled={disabled || !dirty} onClick={onSave}>
          Save changes
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled || jobActive} onClick={onRetry}>
          Regenerate
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close editor
        </Button>
      </div>
    </section>
  );
}
