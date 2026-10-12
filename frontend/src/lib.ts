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
}
export interface Bootstrap {
  settings: Preferences;
  voices: string[];
  cards: Card[];
  active_job: Job | null;
  provider_ready: boolean;
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
export async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(
      typeof value.detail === "string" ? value.detail : "Check the fields and try again.",
    );
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
