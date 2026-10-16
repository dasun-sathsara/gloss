import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AnkiStatus,
  api,
  type Bootstrap,
  type Card,
  type Clip,
  type Conflict,
  editable,
  hasAudio,
  isReady,
  type Job,
  type Parsed,
  type Preferences,
  type Progress,
} from "../lib";

const emptyAnki: AnkiStatus = { connected: false, ready: false, decks: [] };
export function useGloss() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [anki, setAnki] = useState<AnkiStatus>(emptyAnki);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [deck, setDeck] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchIds, setBatchIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("gloss-batch") || "[]"));
    } catch {
      return new Set();
    }
  });
  const initialBatchIds = useRef(batchIds);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<"review" | "library">("review");
  const [search, setSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [moveParent, setMoveParent] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmCap, setConfirmCap] = useState(false);
  const [syncDialog, setSyncDialog] = useState<{
    ids: string[];
    ticket: string;
    profile: string;
  } | null>(null);
  const [allowMissing, setAllowMissing] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [listenAfter, setListenAfter] = useState<{ id: string; kind: Clip } | null>(null);
  const source = useRef<EventSource | null>(null);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const busy = pending || !!job;

  const updateCard = useCallback((card: Card) => {
    setCards((old) =>
      old.some((value) => value.id === card.id)
        ? old.map((value) => (value.id === card.id ? card : value))
        : [card, ...old],
    );
  }, []);
  const refreshAnki = useCallback(async () => {
    const status = await api<AnkiStatus>("/anki");
    setAnki(status);
    if (status.connected) {
      setDeck((old) => old || status.selected_deck || "");
    }
    return status;
  }, []);

  useEffect(() => {
    let disposed = false;
    api<Bootstrap>("/bootstrap")
      .then((value) => {
        if (disposed) return;
        setBootstrap(value);
        setCards(value.cards);
        setJob(value.active_job);
        setDeck(
          (old) =>
            old ||
            value.settings.last_deck ||
            `${value.settings.deck_parent}::${value.settings.deck_default}`,
        );
        const restoredIds = new Set(
          [...initialBatchIds.current].filter((id) => value.cards.some((card) => card.id === id)),
        );
        if (restoredIds.size) {
          setBatchIds(restoredIds);
          const restored = value.cards.find((card) => restoredIds.has(card.id));
          if (restored?.deck) setDeck(restored.deck);
          setSelected(
            new Set(
              value.cards
                .filter((card) => restoredIds.has(card.id) && isReady(card))
                .map((card) => card.id),
            ),
          );
        } else {
          const drafts = value.cards.filter((card) => !card.note_id).slice(0, 100);
          setBatchIds(new Set(drafts.map((card) => card.id)));
          setSelected(new Set(drafts.filter(isReady).map((card) => card.id)));
          if (drafts[0]?.deck) setDeck(drafts[0].deck);
        }
      })
      .catch((error) => setError(error.message));
    refreshAnki().catch((error) => setError(error.message));
    return () => {
      disposed = true;
    };
  }, [refreshAnki]);

  useEffect(() => {
    if (job || pending) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshAnki().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [job, pending, refreshAnki]);

  useEffect(() => {
    if (bootstrap) localStorage.setItem("gloss-batch", JSON.stringify([...batchIds]));
  }, [batchIds, bootstrap]);
  useEffect(() => {
    if (!bootstrap) return;
    const apply = () => {
      const dark =
        bootstrap.settings.theme === "dark" ||
        (bootstrap.settings.theme === "system" &&
          matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.classList.toggle("dark", dark);
    };
    const query = matchMedia("(prefers-color-scheme: dark)");
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [bootstrap]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      if (!text.trim()) {
        setParsed(null);
        return;
      }
      try {
        const response = await fetch("/api/parse", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Could not parse this paste.");
        setParsed(data);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Could not parse.");
      }
    }, 180);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [text]);

  useEffect(() => {
    if (!job) return;
    let ended = false;
    const eventSource = new EventSource(`/api/jobs/${job.id}/events`);
    source.current = eventSource;
    eventSource.addEventListener("card", (event) => {
      const card: Card = JSON.parse((event as MessageEvent).data);
      updateCard(card);
      if (job.kind === "text") {
        setBatchIds((old) => new Set([...old, card.id]));
        if (card.valid) setSelected((old) => new Set([...old, card.id]));
      }
    });
    eventSource.addEventListener("progress", (event) =>
      setProgress(JSON.parse((event as MessageEvent).data)),
    );
    eventSource.addEventListener("failed", (event) =>
      setError(JSON.parse((event as MessageEvent).data).message),
    );
    eventSource.addEventListener("conflicts", (event) =>
      setConflicts(JSON.parse((event as MessageEvent).data)),
    );
    eventSource.addEventListener("sync_started", (event) =>
      setNotice(JSON.parse((event as MessageEvent).data).message),
    );
    eventSource.addEventListener("cancelled", () =>
      setNotice("Stopped. Completed words and audio are saved."),
    );
    eventSource.addEventListener("done", () => {
      ended = true;
      eventSource.close();
      setJob(null);
      setProgress(null);
      if (job.kind === "audio") setNotice("Audio finished.");
      if (job.kind === "sync") refreshAnki().catch(() => {});
    });
    eventSource.onerror = async () => {
      if (ended) return;
      try {
        const value = await api<Bootstrap>("/bootstrap");
        if (ended) return;
        if (!value.active_job || value.active_job.id !== job.id) {
          eventSource.close();
          setJob(null);
          setProgress(null);
          if (dirtyRef.current.size === 0) {
            setCards(value.cards);
            setError("The progress connection ended. Saved work has been reloaded.");
          } else {
            setError("The progress connection ended. Save your open edits, then reopen Gloss.");
          }
        }
      } catch {
        // The server may be briefly unreachable while the run keeps going. Keep the
        // job and its Cancel control so the user is not wedged; EventSource retries.
        setError("Gloss lost its progress connection. It will keep trying; saved work is safe.");
      }
    };
    return () => {
      eventSource.close();
      source.current = null;
    };
  }, [job, refreshAnki, updateCard]);

  useEffect(() => {
    if (!job && listenAfter) {
      const card = cards.find((card) => card.id === listenAfter.id);
      const file = card?.audio[listenAfter.kind];
      if (file)
        new Audio(`/media/${file}`)
          .play()
          .catch(() => setNotice("Your browser blocked playback. Press Play in the card editor."));
      setListenAfter(null);
    }
  }, [job, cards, listenAfter]);

  const perform = async (operation: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The action failed. Try again.");
    } finally {
      setPending(false);
    }
  };
  const saveCard = async (card: Card) => {
    const saved = await api<Card>(`/cards/${card.id}`, "PATCH", editable(card));
    updateCard(saved);
    setDirty((old) => {
      const next = new Set(old);
      next.delete(card.id);
      return next;
    });
    return saved;
  };
  const flush = async () => {
    const values = cardsRef.current.filter((card) => dirty.has(card.id));
    await Promise.all(values.map(saveCard));
  };
  const changeCard = (id: string, patch: Partial<Card>) => {
    setCards((old) =>
      old.map((card) => {
        if (card.id !== id) return card;
        const audio = { ...card.audio };
        // Only invalidate a clip when its text actually changed.
        if (patch.word !== undefined && patch.word !== card.word) delete audio.word;
        if (patch.meaning !== undefined && patch.meaning !== card.meaning) delete audio.meaning;
        if (patch.example1 !== undefined && patch.example1 !== card.example1) delete audio.example1;
        if (patch.example2 !== undefined && patch.example2 !== card.example2) delete audio.example2;
        return { ...card, ...patch, audio };
      }),
    );
    setDirty((old) => new Set([...old, id]));
  };
  const generate = async (confirmed = false) => {
    if (parsed?.over_cap && !confirmed) {
      setConfirmCap(true);
      return;
    }
    await perform(async () => {
      await flush();
      const next = await api<Job>("/generate", "POST", { text, deck, confirm_over_cap: confirmed });
      setBatchIds(new Set());
      setSelected(new Set());
      setView("review");
      setJob(next);
      setProgress(null);
      setConfirmCap(false);
      setNotice("");
    });
  };
  const selection = cards.filter((card) => selected.has(card.id));
  const readySelection = selection.filter((card) => isReady(card) && card.decision !== "skip");
  const visibleCards = cards
    .filter(
      (card) =>
        (view === "library" || batchIds.has(card.id)) &&
        `${card.word} ${card.meaning} ${card.sinhala}`.toLowerCase().includes(search.toLowerCase()),
    )
    // Deterministic order: input order in a batch; newest batch first in the
    // library, still in input order within each batch.
    .sort((a, b) =>
      view === "library"
        ? Math.floor(b.order / 1000) - Math.floor(a.order / 1000) ||
          (a.order % 1000) - (b.order % 1000)
        : a.order - b.order,
    );
  const audio = () =>
    perform(async () => {
      await flush();
      setNotice("");
      setProgress(null);
      setJob(await api<Job>("/audio", "POST", { ids: readySelection.map((card) => card.id) }));
    });
  const assignBatchDeck = async (target: string) => {
    const values = cardsRef.current.filter((card) => batchIds.has(card.id));
    if (!values.length || values.every((card) => card.deck === target)) return;
    const saved = await api<Card[]>("/batch/deck", "PUT", {
      ids: values.map((card) => card.id),
      deck: target,
    });
    for (const card of saved) updateCard(card);
  };
  const chooseDeck = (target: string) =>
    perform(async () => {
      await flush();
      await assignBatchDeck(target);
      setDeck(target);
    });
  const beginSync = () =>
    perform(async () => {
      await flush();
      if (view === "review") await assignBatchDeck(deck);
      const ids = readySelection.map((card) => card.id);
      const found = await api<Conflict[]>("/anki/conflicts", "POST", { ids });
      const unresolved = found.filter(
        (conflict) => cardsRef.current.find((card) => card.id === conflict.id)?.decision === "ask",
      );
      if (unresolved.length) {
        setConflicts(unresolved);
        return;
      }
      const pull = await api<{ ticket: string; profile: string }>("/anki/pull", "POST", { ids });
      setSyncDialog({ ids, ...pull });
      setAllowMissing(false);
    });
  const missing = readySelection.some((card) => !hasAudio(card));

  const remove = (ids: string[]) =>
    perform(async () => {
      const settled = await Promise.allSettled(ids.map((id) => api(`/cards/${id}`, "DELETE")));
      const removed = new Set(ids.filter((_, index) => settled[index].status === "fulfilled"));
      const failed = ids.filter((_, index) => settled[index].status === "rejected");
      setCards((old) => old.filter((card) => !removed.has(card.id)));
      setSelected((old) => new Set([...old].filter((id) => !removed.has(id))));
      setBatchIds((old) => new Set([...old].filter((id) => !removed.has(id))));
      setDirty((old) => new Set([...old].filter((id) => !removed.has(id))));
      if (failed.length) throw new Error(`${failed.length} word(s) could not be removed.`);
    });
  const retry = (card: Card) =>
    perform(async () => {
      await flush();
      setProgress(null);
      setJob(await api<Job>(`/cards/${card.id}/retry`, "POST", {}));
    });
  const listen = (card: Card, kind: Clip) =>
    perform(async () => {
      const saved = dirty.has(card.id) ? await saveCard(card) : card;
      if (saved.audio[kind]) await new Audio(`/media/${saved.audio[kind]}`).play();
      else {
        setListenAfter({ id: card.id, kind });
        setProgress(null);
        setJob(await api<Job>("/audio", "POST", { ids: [card.id], kind }));
      }
    });
  const changeView = (next: "review" | "library") => {
    setView(next);
    setSearch("");
    setSelected(
      next === "review"
        ? new Set(
            cards.filter((card) => batchIds.has(card.id) && isReady(card)).map((card) => card.id),
          )
        : new Set(),
    );
  };
  const saveSettings = async (settings: Preferences) => {
    await flush();
    await api("/settings", "PUT", settings);
    const value = await api<Bootstrap>("/bootstrap");
    setBootstrap(value);
    setCards(value.cards);
    setSettingsOpen(false);
    await refreshAnki();
  };
  return {
    bootstrap,
    cards,
    anki,
    text,
    setText,
    parsed,
    deck,
    chooseDeck,
    selected,
    setSelected,
    batchIds,
    dirty,
    job,
    setJob,
    progress,
    pending,
    busy,
    view,
    changeView,
    search,
    setSearch,
    settingsOpen,
    setSettingsOpen,
    setupOpen,
    setSetupOpen,
    moveParent,
    setMoveParent,
    notice,
    setNotice,
    error,
    setError,
    confirmCap,
    setConfirmCap,
    syncDialog,
    setSyncDialog,
    allowMissing,
    setAllowMissing,
    conflicts,
    setConflicts,
    refreshAnki,
    perform,
    saveCard,
    flush,
    changeCard,
    generate,
    selection,
    readySelection,
    visibleCards,
    audio,
    beginSync,
    missing,
    remove,
    retry,
    listen,
    saveSettings,
  };
}
