export { cn } from "./lib/utils";

export type Clip = "word" | "meaning" | "example1" | "example2";
export const clips: Clip[] = ["word", "meaning", "example1", "example2"];
export type Decision = "ask" | "overwrite" | "keep_both" | "skip";
export interface Card {
  id: string;
  source_word: string;
  hint: string;
  word: string;
  pos: string;
  meaning: string;
  sinhala: string;
  example1: string;
  example2: string;
  valid: boolean;
  reason: string;
  deck: string;
  order: number;
  audio: Partial<Record<Clip, string>>;
  audio_errors: Partial<Record<Clip, string>>;
  decision: Decision;
  note_id: number | null;
  synced_hash: string;
}
export interface Preferences {
  batch_size: number;
  word_cap: number;
  text_model: string;
  tts_model: string;
  voice: string;
  deck_parent: string;
  deck_default: string;
  seed_decks: string[];
  last_deck: string;
  note_type: string;
  tts_concurrency: number;
  tts_rpm: number;
  call_budget: number;
  auto_audio: boolean;
  theme: "system" | "light" | "dark";
  estimated_usd_per_word: number;
}
export interface AnkiStatus {
  connected: boolean;
  ready: boolean;
  profile?: string;
  selected_deck?: string;
  decks: string[];
  warnings?: string[];
  message?: string;
  parent_cards?: number;
}
export interface Entry {
  index: number;
  word: string;
  hint: string;
  duplicate: boolean;
  warning: string;
}
export interface Parsed {
  entries: Entry[];
  count: number;
  over_cap: boolean;
  estimate_usd: number;
  audio_calls: number;
}
export interface Job {
  id: string;
  kind: "text" | "audio" | "sync";
  stage?: "text" | "audio" | "sync";
}
export interface AudioStats {
  clips: number;
  ready: number;
  failed: number;
  skipped: number;
}
export interface Summary {
  words?: number;
  needs_review?: number;
  audio?: AudioStats;
}
export interface Progress {
  stage: string;
  completed: number;
  total: number;
}
export interface Bootstrap {
  settings: Preferences;
  voices: string[];
  cards: Card[];
  card_count: number;
  library_truncated: boolean;
  active_job: Job | null;
  provider_ready: boolean;
  text_provider: string;
  audio_ready: boolean;
  config_dir: string;
  demo: boolean;
  fonts_complete: boolean;
}
export interface Conflict {
  id: string;
  word: string;
  kind: "anki" | "batch";
  existing: Record<string, string>[];
}
function detailFrom(value: unknown): string {
  if (value && typeof value === "object" && "detail" in value) {
    const detail = (value as { detail: unknown }).detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0] as { msg?: unknown };
      if (first && typeof first.msg === "string" && first.msg) return first.msg;
    }
  }
  return "Check the fields and try again.";
}
export async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(detailFrom(value));
  }
  return response.json();
}
export function editable(card: Card) {
  const { word, pos, meaning, sinhala, example1, example2, valid, deck, decision } = card;
  return { word, pos, meaning, sinhala, example1, example2, valid, deck, decision };
}
export function hasAudio(card: Card) {
  return clips.every((clip) => card.audio[clip]);
}
export function isReady(card: Card) {
  return (
    card.valid &&
    [card.word, card.pos, card.meaning, card.sinhala, card.example1, card.example2].every((text) =>
      text.trim(),
    )
  );
}
export function missingClips(card: Card) {
  return clips.filter((clip) => !card.audio[clip]).length;
}
/** Apply a server update to a card the user is still editing without losing their text. */
export function mergeIncoming(local: Card, incoming: Card): Card {
  const audio = { ...local.audio };
  const audioErrors = { ...local.audio_errors };
  for (const clip of clips) {
    // A clip for text the user has since changed must not be attached.
    if (local[clip] !== incoming[clip]) continue;
    if (incoming.audio[clip]) audio[clip] = incoming.audio[clip];
    else delete audio[clip];
    if (incoming.audio_errors[clip]) audioErrors[clip] = incoming.audio_errors[clip];
    else delete audioErrors[clip];
  }
  return { ...local, audio, audio_errors: audioErrors };
}
function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}
export function describeSummary(summary: Summary): string {
  const parts: string[] = [];
  if (summary.words !== undefined) {
    parts.push(`Added ${plural(summary.words, "word")}.`);
    if (summary.needs_review) parts.push(`${summary.needs_review} to review.`);
  }
  const audio = summary.audio;
  if (audio?.clips) {
    if (audio.failed)
      parts.push(
        `Audio: ${audio.ready} of ${audio.clips} clips ready. Choose Prepare audio to retry ${audio.failed === 1 ? "the one" : `the ${audio.failed}`} that failed.`,
      );
    else if (audio.ready === audio.clips) parts.push("Audio is ready.");
    else parts.push(`Audio: ${audio.ready} of ${audio.clips} clips ready.`);
  }
  return parts.join(" ");
}
