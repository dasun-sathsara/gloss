import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AnkiStatus,
  api,
  type Bootstrap,
  type Card,
  type Clip,
  clips,
  type Conflict,
  describeSummary,
  editable,
  hasAudio,
  isReady,
  type Job,
  mergeIncoming,
  missingClips,
  normalizedText,
  type Parsed,
  type Preferences,
  type Progress,
  type Summary,
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
  // Cards whose edits were saved and still need audio. Recorded once the current run ends.
  const [audioQueue, setAudioQueue] = useState<Set<string>>(new Set());
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [playing, setPlaying] = useState<{ id: string; kind: Clip } | null>(null);
  const removed = useRef<Set<string>>(new Set());
  const cleanSnapshots = useRef<Map<string, Card>>(new Map());
  const parseErrorMessage = useRef("");
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const source = useRef<EventSource | null>(null);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const busy = pending || !!job;
  const stage = progress?.stage ?? job?.stage ?? job?.kind;
  const audioRunning = !!job && stage === "audio";
  // Words stay editable while audio records. The server keeps edits and drops stale clips.
  const editLocked = pending || (!!job && !audioRunning);

  const stopAudio = useCallback(() => {
    const current = playerRef.current;
    if (current) {
      playerRef.current = null;
      current.pause();
    }
    setPlaying(null);
  }, []);

  useEffect(() => stopAudio, [stopAudio]);

  const playClip = useCallback(
    (id: string, kind: Clip, file: string, onBlocked?: () => void) => {
      const current = playingRef.current;
      if (current?.id === id && current.kind === kind) {
        stopAudio();
        return;
      }
      stopAudio();
      const audio = new Audio(`/media/${file}`);
      playerRef.current = audio;
      setPlaying({ id, kind });
      const clearIfCurrent = () => {
        if (playerRef.current === audio) {
          playerRef.current = null;
          setPlaying(null);
        }
      };
      audio.addEventListener("ended", clearIfCurrent);
      audio.addEventListener("pause", clearIfCurrent);
      audio.addEventListener("error", () => {
        clearIfCurrent();
        setError("Could not play this audio clip.");
      });
      audio.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        clearIfCurrent();
        if (onBlocked) onBlocked();
        else setError("Could not play this audio clip.");
      });
    },
    [stopAudio],
  );

  const updateCard = useCallback((card: Card) => {
    setCards((old) =>
      old.some((value) => value.id === card.id)
        ? old.map((value) => (value.id === card.id ? card : value))
        : [card, ...old],
    );
  }, []);
  const receiveCard = useCallback((card: Card) => {
    // A run can report a card the user removed a moment ago. Do not bring it back.
    if (removed.current.has(card.id)) return;
    if (dirtyRef.current.has(card.id)) {
      const snap = cleanSnapshots.current.get(card.id);
      if (snap) cleanSnapshots.current.set(card.id, mergeIncoming(snap, card));
    }
    setCards((old) => {
      const local = old.find((value) => value.id === card.id);
      if (!local) return [card, ...old];
      const next = dirtyRef.current.has(card.id) ? mergeIncoming(local, card) : card;
      return old.map((value) => (value.id === card.id ? next : value));
    });
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
    if (bootstrap?.text_health !== "warming") return;
    const timer = setInterval(() => {
      api<{ text_health?: Bootstrap["text_health"]; text_health_detail?: string }>("/health")
        .then((health) => {
          const nextHealth = health.text_health;
          if (!nextHealth) return;
          setBootstrap((old) =>
            old
              ? {
                  ...old,
                  text_health: nextHealth,
                  text_health_detail: health.text_health_detail ?? "",
                }
              : old,
          );
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [bootstrap?.text_health]);

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
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", dark ? "#171b19" : "#fafaf9");
      try {
        localStorage.setItem("gloss-theme", bootstrap.settings.theme);
      } catch {}
    };
    const query = matchMedia("(prefers-color-scheme: dark)");
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [bootstrap]);

  useEffect(() => {
    if (!dirty.size) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty.size]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      if (!text.trim()) {
        setParsed(null);
        if (parseErrorMessage.current) {
          const target = parseErrorMessage.current;
          parseErrorMessage.current = "";
          setError((old) => (old === target ? "" : old));
        }
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
        if (parseErrorMessage.current) {
          const target = parseErrorMessage.current;
          parseErrorMessage.current = "";
          setError((old) => (old === target ? "" : old));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setParsed(null);
          const message = error instanceof Error ? error.message : "Could not parse.";
          parseErrorMessage.current = message;
          setError(message);
        }
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
    const lostWarning =
      "Gloss lost its progress connection. It will keep trying; saved work is safe.";
    let lostConnection = false;
    const clearLostWarning = () => {
      if (!lostConnection) return;
      lostConnection = false;
      setError((old) => (old === lostWarning ? "" : old));
    };
    const eventSource = new EventSource(`/api/jobs/${job.id}/events`);
    source.current = eventSource;
    let outcome: "ok" | "failed" | "cancelled" = "ok";
    eventSource.addEventListener("card", (event) => {
      clearLostWarning();
      const card: Card = JSON.parse((event as MessageEvent).data);
      receiveCard(card);
      if (job.kind === "text" && !removed.current.has(card.id)) {
        setBatchIds((old) => new Set([...old, card.id]));
        if (isReady(card)) setSelected((old) => new Set([...old, card.id]));
      }
    });
    eventSource.addEventListener("progress", (event) => {
      clearLostWarning();
      setProgress(JSON.parse((event as MessageEvent).data));
    });
    eventSource.addEventListener("failed", (event) => {
      lostConnection = false;
      outcome = "failed";
      setError(JSON.parse((event as MessageEvent).data).message);
    });
    eventSource.addEventListener("summary", (event) => {
      clearLostWarning();
      const summary: Summary = JSON.parse((event as MessageEvent).data);
      const message = describeSummary(summary);
      if (message) setNotice(message);
    });
    eventSource.addEventListener("conflicts", (event) => {
      clearLostWarning();
      setConflicts(JSON.parse((event as MessageEvent).data));
    });
    eventSource.addEventListener("sync_started", (event) => {
      clearLostWarning();
      setNotice(JSON.parse((event as MessageEvent).data).message);
    });
    eventSource.addEventListener("cancelled", () => {
      clearLostWarning();
      outcome = "cancelled";
      setNotice("Stopped. Completed words and audio are saved.");
    });
    eventSource.addEventListener("done", () => {
      clearLostWarning();
      ended = true;
      eventSource.close();
      setJob(null);
      setProgress(null);
      // Edits saved during a stopped or failed run wait for the user to choose again.
      if (outcome !== "ok") setAudioQueue(new Set());
      if (job.kind === "sync") refreshAnki().catch(() => {});
    });
    eventSource.onerror = async () => {
      if (ended) return;
      try {
        const value = await api<Bootstrap>("/bootstrap");
        if (ended) return;
        if (!value.active_job || value.active_job.id !== job.id) {
          ended = true;
          eventSource.close();
          setJob(null);
          setProgress(null);
          setCards((old) => {
            const localById = new Map(old.map((card) => [card.id, card]));
            return value.cards
              .filter((card) => !removed.current.has(card.id))
              .map((card) => {
                const local = localById.get(card.id);
                return local && dirtyRef.current.has(card.id) ? mergeIncoming(local, card) : card;
              });
          });
          setError("The progress connection ended. Saved work has been reloaded.");
        }
      } catch {
        // The server may be briefly unreachable while the run keeps going. Keep the
        // job and its Cancel control so the user is not wedged; EventSource retries.
        lostConnection = true;
        setError(lostWarning);
      }
    };
    return () => {
      eventSource.close();
      source.current = null;
    };
  }, [job, refreshAnki, receiveCard]);

  useEffect(() => {
    if (job || pending || !audioQueue.size || !bootstrap?.audio_ready) return;
    const ids = [...audioQueue].filter((id) => {
      const card = cardsRef.current.find((value) => value.id === id);
      return card && isReady(card) && !hasAudio(card) && !dirtyRef.current.has(id);
    });
    setAudioQueue(new Set());
    if (!ids.length) return;
    setPending(true);
    api<Job>("/audio", "POST", { ids })
      .then((next) => {
        setProgress(null);
        setJob(next);
      })
      .catch((error) =>
        setError(error instanceof Error ? error.message : "Audio could not start. Try again."),
      )
      .finally(() => setPending(false));
  }, [job, pending, audioQueue, bootstrap?.audio_ready]);

  useEffect(() => {
    if (!job && listenAfter) {
      const card = cards.find((card) => card.id === listenAfter.id);
      const file = card?.audio[listenAfter.kind];
      if (file) {
        playClip(listenAfter.id, listenAfter.kind, file, () =>
          setNotice("Your browser blocked playback. Press Play in the card editor."),
        );
      }
      setListenAfter(null);
    }
  }, [job, cards, listenAfter, playClip]);

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
    cleanSnapshots.current.delete(card.id);
    updateCard(saved);
    setDirty((old) => {
      const next = new Set(old);
      next.delete(card.id);
      return next;
    });
    return saved;
  };
  /** Save from the editor, then record any clip the edit invalidated. */
  const saveEdit = async (card: Card) => {
    const prev = cleanSnapshots.current.get(card.id);
    const wasReady = prev ? isReady(prev) : isReady(card);
    const saved = await saveCard(card);
    if (!wasReady && isReady(saved) && batchIds.has(saved.id) && view === "review") {
      setSelected((old) => new Set([...old, saved.id]));
    }
    if (
      bootstrap?.audio_ready &&
      bootstrap?.settings.auto_audio &&
      isReady(saved) &&
      !hasAudio(saved)
    )
      setAudioQueue((old) => new Set([...old, saved.id]));
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
        if (!dirtyRef.current.has(id) && !cleanSnapshots.current.has(id)) {
          cleanSnapshots.current.set(id, card);
        }
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
  const discardCard = useCallback(
    (id: string) => {
      const snapshot = cleanSnapshots.current.get(id);
      cleanSnapshots.current.delete(id);
      if (snapshot) {
        setCards((old) =>
          old.map((card) => {
            if (card.id !== id) return card;
            const audio = { ...snapshot.audio };
            for (const clip of clips) {
              if (card[clip] === snapshot[clip] && card.audio[clip]) {
                audio[clip] = card.audio[clip];
              }
            }
            return { ...snapshot, audio };
          }),
        );
      }
      setDirty((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      });
      if (playingRef.current?.id === id) stopAudio();
    },
    [stopAudio],
  );
  const generate = async (confirmed = false) => {
    if (parsed?.over_cap && !confirmed) {
      setConfirmCap(true);
      return;
    }
    await perform(async () => {
      await flush();
      const next = await api<Job>("/generate", "POST", { text, deck, confirm_over_cap: confirmed });
      // New words join the words still waiting for Anki in this deck. Synced words and
      // other decks leave the batch and stay in the library.
      const keep = new Set(
        cardsRef.current
          .filter((card) => batchIds.has(card.id) && !card.note_id && card.deck === deck)
          .map((card) => card.id),
      );
      setBatchIds(keep);
      setSelected((old) => new Set([...old].filter((id) => keep.has(id))));
      setText("");
      setView("review");
      setJob(next);
      setProgress(null);
      setConfirmCap(false);
      setNotice("");
    });
  };
  const selection = useMemo(() => cards.filter((card) => selected.has(card.id)), [cards, selected]);
  const readySelection = useMemo(
    () => selection.filter((card) => isReady(card) && card.decision !== "skip"),
    [selection],
  );
  const visibleCards = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (
      cards
        .filter(
          (card) =>
            (view === "library" || batchIds.has(card.id)) &&
            (!query ||
              `${card.word} ${card.source_word} ${card.pos} ${card.meaning} ${card.sinhala} ${card.example1} ${card.example2} ${view === "library" ? card.deck : ""}`
                .toLowerCase()
                .includes(query)),
        )
        // Deterministic order: input order in a batch; newest batch first in the
        // library, still in input order within each batch.
        .sort((a, b) =>
          view === "library"
            ? Math.floor(b.order / 1000) - Math.floor(a.order / 1000) ||
              (a.order % 1000) - (b.order % 1000)
            : a.order - b.order,
        )
    );
  }, [cards, view, batchIds, search]);
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
  const pullAndOpenSync = async (ids: string[]) => {
    const pull = await api<{ ticket: string; profile: string }>("/anki/pull", "POST", { ids });
    setSyncDialog({ ids, ...pull });
    setAllowMissing(false);
  };
  const beginSync = () =>
    perform(async () => {
      await flush();
      if (view === "review") await assignBatchDeck(deck);
      const ids = readySelection.map((card) => card.id);
      const found = await api<Conflict[]>("/anki/conflicts", "POST", { ids });
      const byId = new Map(cardsRef.current.map((card) => [card.id, card]));
      const hasAsk = found.some((conflict) => byId.get(conflict.id)?.decision === "ask");
      const collisionGroups = new Map<string, number>();
      for (const id of ids) {
        const card = byId.get(id);
        if (!card || card.decision === "skip" || card.decision === "keep_both") continue;
        const key = `${normalizedText(card.word)}\0${normalizedText(card.pos)}`;
        collisionGroups.set(key, (collisionGroups.get(key) ?? 0) + 1);
      }
      const hasBatchCollision = found.some((conflict) => {
        if (conflict.kind !== "batch") return false;
        const card = byId.get(conflict.id);
        if (!card || card.decision === "skip" || card.decision === "keep_both") return false;
        const key = `${normalizedText(card.word)}\0${normalizedText(card.pos)}`;
        return (collisionGroups.get(key) ?? 0) > 1;
      });
      if (hasAsk || hasBatchCollision) {
        setConflicts(found);
        return;
      }
      await pullAndOpenSync(ids);
    });
  const resolveConflicts = () =>
    perform(async () => {
      await flush();
      const ids = cardsRef.current
        .filter((card) => selected.has(card.id) && isReady(card) && card.decision !== "skip")
        .map((card) => card.id);
      if (!ids.length) {
        setConflicts([]);
        setNotice("Skipped the conflicting words.");
        return;
      }
      if (view === "review") await assignBatchDeck(deck);
      await pullAndOpenSync(ids);
      setConflicts([]);
    });

  const missing = useMemo(() => readySelection.some((card) => !hasAudio(card)), [readySelection]);
  const missingCount = useMemo(
    () => readySelection.reduce((total, card) => total + missingClips(card), 0),
    [readySelection],
  );

  const remove = (ids: string[]) =>
    perform(async () => {
      const settled = await Promise.allSettled(ids.map((id) => api(`/cards/${id}`, "DELETE")));
      const gone = new Set(ids.filter((_, index) => settled[index].status === "fulfilled"));
      const failed = ids.filter((_, index) => settled[index].status === "rejected");
      for (const id of gone) {
        removed.current.add(id);
        cleanSnapshots.current.delete(id);
      }
      if (playingRef.current && gone.has(playingRef.current.id)) stopAudio();
      setCards((old) => old.filter((card) => !gone.has(card.id)));
      setSelected((old) => new Set([...old].filter((id) => !gone.has(id))));
      setBatchIds((old) => new Set([...old].filter((id) => !gone.has(id))));
      setDirty((old) => new Set([...old].filter((id) => !gone.has(id))));
      setAudioQueue((old) => new Set([...old].filter((id) => !gone.has(id))));
      setRemoveIds([]);
      if (failed.length)
        throw new Error(
          `${failed.length} ${failed.length === 1 ? "word" : "words"} could not be removed.`,
        );
    });
  const retry = (card: Card) =>
    perform(async () => {
      const otherDirty = cardsRef.current.filter(
        (value) => dirty.has(value.id) && value.id !== card.id,
      );
      await Promise.all(otherDirty.map(saveCard));
      cleanSnapshots.current.delete(card.id);
      setDirty((old) => {
        const next = new Set(old);
        next.delete(card.id);
        return next;
      });
      setProgress(null);
      setJob(await api<Job>(`/cards/${card.id}/retry`, "POST", {}));
    });
  const listen = (card: Card, kind: Clip) => {
    const existing = card.audio[kind];
    if (existing) {
      playClip(card.id, kind, existing);
      return;
    }
    void perform(async () => {
      if (!bootstrap?.audio_ready)
        throw new Error("Audio needs a Google Cloud project or WOOF_MODEL_DIR in the config .env.");
      if (!isReady(card))
        throw new Error(
          "Complete all word, definition, and example fields before generating audio.",
        );
      const saved = dirty.has(card.id) ? await saveEdit(card) : card;
      const cached = saved.audio[kind];
      if (cached) {
        playClip(saved.id, kind, cached);
        return;
      }
      setListenAfter({ id: saved.id, kind });
      setProgress(null);
      setJob(await api<Job>("/audio", "POST", { ids: [saved.id], kind }));
    });
  };
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
    cleanSnapshots.current.clear();
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
    audioRunning,
    editLocked,
    removeIds,
    setRemoveIds,
    missingCount,
    saveEdit,
    discardCard,
    playing,
    stopAudio,
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
    resolveConflicts,
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
