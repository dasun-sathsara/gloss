import { describe, expect, it } from "vitest";
import { type Card, editable, hasAudio, isReady } from "./lib";

const card: Card = {
  id: "one",
  source_word: "curious",
  hint: "",
  word: "curious",
  pos: "adjective",
  meaning: "Wanting to learn.",
  sinhala: "කුතුහලයෙන් පිරි",
  example1: "I am curious.",
  example2: "The child was curious.",
  valid: true,
  reason: "",
  deck: "Gloss::General",
  audio: { word: "word.mp3", meaning: "meaning.mp3", example1: "1.mp3", example2: "2.mp3" },
  audio_errors: {},
  decision: "ask",
  note_id: null,
  synced_hash: "",
};

describe("review gating", () => {
  it("holds incomplete and invalid entries back", () => {
    expect(isReady(card)).toBe(true);
    expect(isReady({ ...card, valid: false })).toBe(false);
    expect(isReady({ ...card, sinhala: " " })).toBe(false);
  });
  it("requires all four clips for complete audio", () => {
    expect(hasAudio(card)).toBe(true);
    expect(hasAudio({ ...card, audio: { word: "word.mp3" } })).toBe(false);
  });
  it("sends only editable fields back to the server", () => {
    expect(editable(card)).not.toHaveProperty("audio");
    expect(editable(card)).not.toHaveProperty("note_id");
    expect(editable(card)).toHaveProperty("sinhala", card.sinhala);
  });
});
