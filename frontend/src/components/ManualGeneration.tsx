import { useEffect, useRef, useState } from "react";
import type { ManualRun } from "../lib";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function ManualStart({
  size,
  wordCount,
  busy,
  disabled,
  onStart,
}: {
  size: number;
  wordCount: number;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  const count = Math.ceil(wordCount / size);
  return (
    <div className="manual-options">
      {count > 0 && (
        <p className="help">
          {count} {count === 1 ? "batch" : "batches"} · up to {size} words each
        </p>
      )}
      <Button disabled={disabled || busy} onClick={onStart}>
        Start manual generation
      </Button>
    </div>
  );
}

export function ManualBatch({
  run,
  busy,
  error,
  focusCopy,
  onImport,
  onClose,
}: {
  run: ManualRun;
  busy: boolean;
  error: { message: string; canCorrect: boolean } | null;
  focusCopy: boolean;
  onImport: (reply: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("gloss-manual-reply") || "null");
      if (saved?.code === run.code && typeof saved.text === "string") {
        return { text: saved.text as string, copied: saved.copied === true };
      }
    } catch {
      // A blocked browser store still allows pasting and importing.
    }
    return { text: "", copied: false };
  });
  const reply = draft.text;
  const saveDraft = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    try {
      localStorage.setItem("gloss-manual-reply", JSON.stringify({ code: run.code, ...next }));
    } catch {
      setPasteStatus(
        "Gloss can't save this reply in your browser. Keep this tab open until you import it.",
      );
    }
  };
  const setReply = (text: string) => saveDraft({ text });
  const promptField = useRef<HTMLTextAreaElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusCopy) copyButton.current?.focus();
  }, [focusCopy]);
  const correction =
    "Return one complete replacement reply for this batch. " +
    (error?.message ?? "") +
    "\n\n" +
    run.full_prompt;
  const [copyStatus, setCopyStatus] = useState("");
  const [pasteStatus, setPasteStatus] = useState("");
  const [showPrompt, setShowPrompt] = useState<"full" | "short" | "correction" | null>(null);
  const [promptFallback, setPromptFallback] = useState(false);
  useEffect(() => {
    if (promptFallback && showPrompt) promptField.current?.focus();
  }, [promptFallback, showPrompt]);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const replyField = useRef<HTMLTextAreaElement>(null);
  const hasMore = run.completed + run.current_count < run.total;
  const first = run.number === 1;
  const defaultPrompt = first ? "full" : "short";

  const copy = async (kind: "full" | "short" | "correction") => {
    const prompt =
      kind === "correction" ? correction : kind === "full" ? run.full_prompt : run.short_prompt;
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptFallback(false);
      setShowPrompt(null);
      saveDraft({ copied: true });
      replyField.current?.focus();
      setCopyStatus(
        kind === "correction"
          ? "Correction prompt copied."
          : kind === "full"
            ? "Full prompt copied."
            : "Continuation prompt copied.",
      );
    } catch {
      setPromptFallback(true);
      setShowPrompt(kind);
      setCopyStatus("Gloss couldn't copy the prompt. Copy it from the box below.");
    }
  };

  const paste = async () => {
    try {
      const value = await navigator.clipboard.readText();
      if (!value.trim()) {
        setPasteStatus("Copy the JSON reply from Gemini first. Your clipboard is empty.");
        return;
      }
      if (value.length > 750000) {
        setPasteStatus("The reply is too long. Copy just the JSON and try again.");
        return;
      }
      setPasteStatus("Reply pasted.");
      setReply(value);
    } catch {
      setPasteStatus("Paste the reply into the box below.");
    }
    replyField.current?.focus();
  };

  if (!run.current_count)
    return (
      <div className="manual-options">
        <h2 role="status">
          {run.total} {run.total === 1 ? "word" : "words"} imported.
        </h2>
        <Button disabled={busy} onClick={onClose}>
          Done
        </Button>
      </div>
    );

  return (
    <div className="manual-options">
      <div className="manual-progress" role="status">
        <h2>
          Batch {run.number} of {Math.ceil(run.total / run.size)}
        </h2>
        <progress value={run.completed} max={run.total} aria-label="Words imported" />
        <p className="help">
          {!error && draft.copied && !reply.trim() && (
            <>
              Waiting for a Gemini reply
              <br />
            </>
          )}
          Gloss imported {run.completed} of {run.total} words.
        </p>
      </div>

      <section className="manual-step" aria-label="Copy the prompt">
        <h3>1. Copy the prompt</h3>
        <p className="help">
          {first
            ? "Paste the prompt into a new Gemini chat."
            : "Use the full prompt in a new chat."}
        </p>
        <div className="manual-actions">
          <Button ref={copyButton} disabled={busy} onClick={() => void copy(defaultPrompt)}>
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
              setPromptFallback(false);
              setCopyStatus("");
              setShowPrompt(showPrompt ? null : defaultPrompt);
            }}
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
            ref={promptField}
            aria-label="Prompt text"
            rows={5}
            readOnly
            value={
              showPrompt === "correction"
                ? correction
                : showPrompt === "full"
                  ? run.full_prompt
                  : run.short_prompt
            }
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
          placeholder="Paste the JSON reply"
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
            <AlertDescription>
              <p>{error.message}</p>
              {error.canCorrect && (
                <Button variant="outline" size="sm" onClick={() => void copy("correction")}>
                  Copy correction prompt
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
      </section>

      <Button disabled={busy || !reply.trim()} onClick={() => onImport(reply)}>
        {hasMore ? "Validate and continue" : "Validate and finish"}
      </Button>
      {confirmEnd ? (
        <>
          <p className="help">
            End this run and discard the words you haven't imported? Gloss keeps your saved drafts.
          </p>
          <div className="manual-actions">
            <Button variant="destructive" disabled={busy} onClick={onClose}>
              End run
            </Button>
            <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
              Keep run open
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
