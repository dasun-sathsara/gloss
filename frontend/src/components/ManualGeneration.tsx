import { useRef, useState } from "react";
import type { ManualRun } from "../lib";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const sizeKey = "gloss-manual-size";

function validSize(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 100;
}

function loadSize(defaultSize: number) {
  try {
    const value = localStorage.getItem(sizeKey);
    const size = Number(
      value ?? JSON.parse(localStorage.getItem("gloss-manual-options") || "{}").size,
    );
    return validSize(size) ? size : defaultSize;
  } catch {
    return defaultSize;
  }
}

export function ManualStart({
  defaultSize,
  wordCount,
  busy,
  disabled,
  onStart,
}: {
  defaultSize: number;
  wordCount: number;
  busy: boolean;
  disabled: boolean;
  onStart: (size: number) => void;
}) {
  const [size, setSize] = useState(() => loadSize(defaultSize));
  const count = validSize(size) ? Math.ceil(wordCount / size) : 0;
  return (
    <div className="manual-options">
      <Field>
        <FieldLabel htmlFor="manual-size">Words per prompt</FieldLabel>
        <Input
          id="manual-size"
          type="number"
          min={1}
          max={100}
          value={size || ""}
          disabled={busy}
          aria-describedby="manual-size-hint"
          onChange={(event) => setSize(Number(event.target.value))}
        />
        <p className="help" id="manual-size-hint">
          {!validSize(size)
            ? "Enter a batch size from 1 to 100."
            : count
              ? `${wordCount} ${wordCount === 1 ? "word" : "words"} in ${count} ${count === 1 ? "batch" : "batches"}`
              : "Try 25 words per prompt."}
        </p>
      </Field>
      <Button
        disabled={disabled || busy || !validSize(size)}
        onClick={() => {
          try {
            localStorage.setItem(sizeKey, String(size));
            localStorage.removeItem("gloss-manual-options");
          } catch {
            // The current run can still start if browser storage is disabled.
          }
          onStart(size);
        }}
      >
        Start manual generation
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
  const [pasteStatus, setPasteStatus] = useState("");
  const [showPrompt, setShowPrompt] = useState<"full" | "short" | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const replyField = useRef<HTMLTextAreaElement>(null);
  const hasMore = run.completed + run.current_count < run.total;
  const first = run.number === 1;
  const defaultPrompt = first ? "full" : "short";

  const copy = async (kind: "full" | "short") => {
    const prompt = kind === "full" ? run.full_prompt : run.short_prompt;
    try {
      await navigator.clipboard.writeText(prompt);
      setShowPrompt(null);
      setCopyStatus(kind === "full" ? "Full prompt copied." : "Continuation prompt copied.");
    } catch {
      setShowPrompt(kind);
      setCopyStatus("Clipboard unavailable. Copy the prompt below.");
    }
  };

  const paste = async () => {
    try {
      const value = await navigator.clipboard.readText();
      if (!value.trim()) {
        setPasteStatus("Clipboard is empty. Copy the JSON reply first.");
        return;
      }
      if (value.length > 750000) {
        setPasteStatus("That reply is too large. Paste a smaller batch.");
        return;
      }
      setReply(value);
      setPasteStatus("");
    } catch {
      setPasteStatus("Paste directly into the box below.");
    }
    replyField.current?.focus();
  };

  if (!run.current_count)
    return (
      <div className="manual-options">
        <h2 role="status">
          {run.total} {run.total === 1 ? "word" : "words"} imported.
        </h2>
        <p className="help">Review your drafts before preparing audio or syncing to Anki.</p>
        <Button disabled={busy} onClick={onClose}>
          Done
        </Button>
      </div>
    );

  return (
    <div className="manual-options">
      <div className="manual-progress" role="status">
        <h2>Batch {run.number}</h2>
        <progress value={run.completed} max={run.total} aria-label="Words imported" />
        <p className="help">
          {run.completed} of {run.total} words imported · {run.current_count} in this batch
        </p>
      </div>

      <section className="manual-step" aria-label="Copy the prompt">
        <h3>1. Copy the prompt</h3>
        <p className="help">
          {first
            ? "Paste it into a new Gemini chat."
            : "Use the short prompt in the same Gemini chat."}
        </p>
        <div className="manual-actions">
          <Button disabled={busy} onClick={() => void copy(defaultPrompt)}>
            {first ? "Copy full prompt" : "Copy continuation prompt"}
          </Button>
          {!first && (
            <Button variant="outline" disabled={busy} onClick={() => void copy("full")}>
              Copy full prompt
            </Button>
          )}
          <Button
            variant="ghost"
            aria-expanded={!!showPrompt}
            onClick={() => {
              setCopyStatus("");
              setShowPrompt(showPrompt ? null : defaultPrompt);
            }}
          >
            {showPrompt ? "Hide prompt" : "View prompt"}
          </Button>
        </div>
        {!first && <p className="help">Starting a new chat? Use the full prompt.</p>}
        {copyStatus && (
          <p className="help" role="status">
            {copyStatus}
          </p>
        )}
        {showPrompt && (
          <Textarea
            aria-label="Prompt text"
            rows={5}
            readOnly
            value={showPrompt === "full" ? run.full_prompt : run.short_prompt}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
      </section>

      <section className="manual-step" aria-label="Paste the reply">
        <div className="manual-step-heading">
          <h3>2. Paste the reply</h3>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void paste()}>
            Paste reply
          </Button>
        </div>
        {pasteStatus && (
          <p className="help" role="status">
            {pasteStatus}
          </p>
        )}
        <Textarea
          ref={replyField}
          aria-label="JSON reply"
          placeholder="Paste the JSON reply here"
          rows={4}
          maxLength={750000}
          disabled={busy}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? "manual-error" : undefined}
          value={reply}
          onChange={(event) => {
            setPasteStatus("");
            setReply(event.target.value);
          }}
        />
        {error && (
          <Alert id="manual-error" variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>

      {hasMore && (
        <details>
          <summary>Change remaining batch size</summary>
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
        </details>
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
