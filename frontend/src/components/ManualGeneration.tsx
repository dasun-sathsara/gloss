import { useState } from "react";
import type { ManualOptions, ManualRun } from "../lib";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const optionsKey = "gloss-manual-options";

function loadOptions(defaults: ManualOptions): ManualOptions {
  try {
    const value = JSON.parse(localStorage.getItem(optionsKey) || "{}");
    return {
      size: validSize(value.size) ? value.size : defaults.size,
      instructions:
        typeof value.instructions === "string" ? value.instructions : defaults.instructions,
      continuation:
        typeof value.continuation === "string" ? value.continuation : defaults.continuation,
    };
  } catch {
    return defaults;
  }
}

function validSize(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 100;
}

export function ManualStart({
  defaults,
  busy,
  disabled,
  onStart,
}: {
  defaults: ManualOptions;
  busy: boolean;
  disabled: boolean;
  onStart: (options: ManualOptions) => void;
}) {
  const [options, setOptions] = useState(() => loadOptions(defaults));
  const update = (patch: Partial<ManualOptions>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    try {
      localStorage.setItem(optionsKey, JSON.stringify(next));
    } catch {
      // The current run can still start if browser storage is disabled.
    }
  };
  return (
    <div className="manual-options">
      <Field>
        <FieldLabel htmlFor="manual-size">Words per prompt</FieldLabel>
        <Input
          id="manual-size"
          type="number"
          min={1}
          max={100}
          value={options.size || ""}
          disabled={busy}
          onChange={(event) => update({ size: Number(event.target.value) })}
        />
      </Field>
      <details>
        <summary>Customize prompts</summary>
        <div className="manual-options">
          <Field>
            <FieldLabel htmlFor="manual-instructions">New chat instructions</FieldLabel>
            <Textarea
              id="manual-instructions"
              rows={5}
              maxLength={4000}
              value={options.instructions}
              disabled={busy}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="manual-continuation">Same chat instructions</FieldLabel>
            <Textarea
              id="manual-continuation"
              rows={2}
              maxLength={1000}
              value={options.continuation}
              disabled={busy}
              onChange={(event) => update({ continuation: event.target.value })}
            />
          </Field>
          <p className="help">
            Gloss adds the required JSON format, batch code, and numbered words.
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => update(defaults)}>
            Restore defaults
          </Button>
        </div>
      </details>
      <Button
        disabled={disabled || busy || !validSize(options.size) || !options.instructions.trim()}
        onClick={() => onStart(options)}
      >
        Create manual batches
      </Button>
    </div>
  );
}

export function ManualBatch({
  run,
  busy,
  error,
  onImport,
  onClose,
}: {
  run: ManualRun;
  busy: boolean;
  error: string;
  onImport: (reply: string, nextSize: number) => void;
  onClose: () => void;
}) {
  const [reply, setReply] = useState("");
  const [nextSize, setNextSize] = useState(run.size);
  const [copyStatus, setCopyStatus] = useState("");
  const [showPrompt, setShowPrompt] = useState<"full" | "short" | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const hasMore = run.completed + run.current_count < run.total;
  const copy = async (kind: "full" | "short") => {
    const prompt = kind === "full" ? run.full_prompt : run.short_prompt;
    try {
      await navigator.clipboard.writeText(prompt);
      setShowPrompt(null);
      setCopyStatus("Prompt copied.");
    } catch {
      setShowPrompt(kind);
      setCopyStatus("Couldn’t access the clipboard. Select and copy the prompt below.");
    }
  };

  if (!run.current_count)
    return (
      <div className="manual-options">
        <p role="status">
          {run.total} words imported. Review them before preparing audio or syncing.
        </p>
        <Button disabled={busy} onClick={onClose}>
          Done
        </Button>
      </div>
    );

  return (
    <div className="manual-options">
      <div role="status">
        <h2>Batch {run.number}</h2>
        <p className="help">
          {run.completed} of {run.total} words imported · {run.current_count} in this prompt
        </p>
      </div>
      <p className="help">
        Paste the prompt into Gemini or another chat, then paste its JSON reply here.
      </p>
      <div className="manual-actions">
        {run.number > 1 && (
          <Button onClick={() => void copy("short")}>Copy continuation prompt</Button>
        )}
        <Button
          variant={run.number === 1 ? "default" : "outline"}
          onClick={() => void copy("full")}
        >
          Copy full prompt
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowPrompt(showPrompt ? null : run.number === 1 ? "full" : "short")}
        >
          {showPrompt ? "Hide prompt" : "View prompt"}
        </Button>
      </div>
      {copyStatus && (
        <p className="help" role="status">
          {copyStatus}
        </p>
      )}
      {showPrompt && (
        <Textarea
          aria-label="Prompt text"
          rows={7}
          readOnly
          value={showPrompt === "full" ? run.full_prompt : run.short_prompt}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      <Field>
        <FieldLabel htmlFor="manual-reply">JSON reply</FieldLabel>
        <Textarea
          id="manual-reply"
          placeholder="Paste the JSON code block here"
          rows={6}
          maxLength={750000}
          disabled={busy}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? "manual-error" : undefined}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
        />
      </Field>
      {error && (
        <Alert id="manual-error" variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {hasMore && (
        <Field>
          <FieldLabel htmlFor="manual-next-size">Words per remaining batch</FieldLabel>
          <Input
            id="manual-next-size"
            type="number"
            min={1}
            max={100}
            value={nextSize || ""}
            disabled={busy}
            onChange={(event) => setNextSize(Number(event.target.value))}
          />
          <p className="help">Does not change this prompt.</p>
        </Field>
      )}
      <Button
        disabled={busy || !reply.trim() || (hasMore && !validSize(nextSize))}
        onClick={() => onImport(reply, hasMore ? nextSize : run.size)}
      >
        {hasMore ? "Validate and continue" : "Validate and finish"}
      </Button>
      {confirmEnd ? (
        <>
          <p className="help">
            End this run and discard unimported words? Saved drafts stay in Gloss.
          </p>
          <div className="manual-actions">
            <Button variant="destructive" disabled={busy} onClick={onClose}>
              End run
            </Button>
            <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
              Keep going
            </Button>
          </div>
        </>
      ) : (
        <Button variant="ghost" disabled={busy} onClick={() => setConfirmEnd(true)}>
          Cancel run
        </Button>
      )}
    </div>
  );
}
