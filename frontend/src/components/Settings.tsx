import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { useState } from "react";
import type { AnkiStatus, Preferences } from "../lib";
import { Choice } from "./Choice";
import { Spinner } from "./Spinner";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

type NumericKey = "word_cap" | "tts_rpm" | "call_budget" | "estimated_usd_per_word";

const numericSpecs: Record<
  NumericKey,
  { label: string; min: number; max: number; integer: boolean }
> = {
  word_cap: { label: "Word cap", min: 1, max: 100, integer: true },
  tts_rpm: { label: "Speech requests per minute", min: 1, max: 120, integer: true },
  call_budget: { label: "Audio clip ceiling per run", min: 4, max: 1000, integer: true },
  estimated_usd_per_word: { label: "Estimated USD per word", min: 0, max: 1, integer: false },
};

export function Settings({
  settings,
  voices,
  audioProvider,
  audioVoice,
  configDir,
  anki,
  audioReady,
  onSave,
  onAddDeck,
  busy,
}: {
  settings: Preferences;
  voices: string[];
  audioProvider: "demo" | "woof" | "google" | "";
  audioVoice: string;
  configDir: string;
  anki: AnkiStatus;
  audioReady: boolean;
  onSave: (preferences: Preferences) => Promise<void>;
  onAddDeck: (name: string) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(settings);
  const [numericText, setNumericText] = useState<Record<NumericKey, string>>(() => ({
    word_cap: String(settings.word_cap),
    tts_rpm: String(settings.tts_rpm),
    call_budget: String(settings.call_budget),
    estimated_usd_per_word: String(settings.estimated_usd_per_word),
  }));
  const [subjects, setSubjects] = useState(settings.seed_decks.join(", "));
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const change = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const locked = busy || saving;
  const canAddDeck =
    !locked && anki.connected && !!name.trim() && draft.deck_parent === settings.deck_parent;
  const addDeck = async () => {
    if (!canAddDeck) return;
    setSaving(true);
    setError("");
    try {
      await onAddDeck(name.trim());
      setName("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not add deck.");
    } finally {
      setSaving(false);
    }
  };
  const input = (
    key: keyof Preferences,
    label: string,
    numeric?: { min: number; max?: number; step?: number },
  ) => (
    <Field className="gap-1.5" key={key}>
      <FieldLabel htmlFor={`settings-${key}`}>{label}</FieldLabel>
      <Input
        id={`settings-${key}`}
        disabled={locked}
        type={numeric ? "number" : "text"}
        {...numeric}
        value={numeric ? numericText[key as NumericKey] : String(draft[key])}
        onChange={(event) => {
          if (numeric) {
            const raw = event.target.value;
            setNumericText((old) => ({ ...old, [key]: raw }));
          } else {
            change(key, event.target.value);
          }
        }}
      />
    </Field>
  );
  return (
    <form
      className="settings-body"
      onSubmit={async (event) => {
        event.preventDefault();
        const parsedNumbers: Partial<Record<NumericKey, number>> = {};
        const keys: NumericKey[] =
          audioProvider === "woof"
            ? ["word_cap", "call_budget"]
            : ["word_cap", "tts_rpm", "call_budget", "estimated_usd_per_word"];
        for (const key of keys) {
          const spec = numericSpecs[key];
          const raw = numericText[key].trim();
          const value = Number(raw);
          if (
            !raw ||
            !Number.isFinite(value) ||
            (spec.integer && !Number.isInteger(value)) ||
            value < spec.min ||
            value > spec.max
          ) {
            setError(
              `${spec.label} must be ${spec.integer ? "a whole number" : "a number"} between ${spec.min} and ${spec.max}.`,
            );
            return;
          }
          parsedNumbers[key] = value;
        }
        setSaving(true);
        setError("");
        try {
          await onSave({
            ...draft,
            ...parsedNumbers,
            seed_decks: subjects
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          });
        } catch (error) {
          setError(error instanceof Error ? error.message : "Could not save settings.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="settings-grid">
        {audioProvider === "woof" ? (
          <Field className="gap-1.5 settings-note">
            <FieldLabel>Audio</FieldLabel>
            <p className="help">
              Local (Woof), voice <strong>{audioVoice}</strong>. Set <code>WOOF_VOICE</code> in the
              config <code>.env</code> to switch between <code>juno</code> and <code>mira</code>.
            </p>
          </Field>
        ) : (
          <Choice
            label="Voice"
            value={draft.voice}
            disabled={locked || !audioReady}
            options={voices.map((value) => ({ value, label: value }))}
            onChange={(value) => change("voice", value)}
          />
        )}
        <Choice
          label="Words per request"
          value={String(draft.batch_size)}
          disabled={locked}
          options={[1, 3, 5].map((value) => ({ value: String(value), label: String(value) }))}
          onChange={(value) => change("batch_size", Number(value))}
        />
        {input("word_cap", "Word cap", { min: 1, max: 100 })}
        <Choice
          label="Appearance"
          value={draft.theme}
          disabled={locked}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(value) => change("theme", value as Preferences["theme"])}
        />
      </div>
      <Field orientation="horizontal" className="gap-2">
        <Checkbox
          id="settings-auto_audio"
          checked={draft.auto_audio}
          disabled={locked || !audioReady}
          onCheckedChange={(checked) => change("auto_audio", checked === true)}
        />
        <FieldLabel htmlFor="settings-auto_audio">
          Record audio automatically after writing words and saving edits
        </FieldLabel>
      </Field>
      {!audioReady && (
        <p className="help">
          Audio needs a Google Cloud project or <code>WOOF_MODEL_DIR</code> in the config{" "}
          <code>.env</code>. Words generate without it.
        </p>
      )}
      <section className="settings-section">
        <h3>Anki</h3>
        <div className="settings-grid">
          {input("deck_parent", "Parent deck")}
          {input("deck_default", "Default subdeck")}
          {input("note_type", "Note type")}
          <Field className="gap-1.5">
            <FieldLabel htmlFor="settings-subjects">Starting subdecks (comma separated)</FieldLabel>
            <Input
              id="settings-subjects"
              disabled={locked}
              value={subjects}
              onChange={(event) => setSubjects(event.target.value)}
            />
          </Field>
        </div>
        <p className="help">Run Anki setup after changing the parent deck or note type.</p>
        <div className="add-deck">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="new-deck">New subdeck</FieldLabel>
            <Input
              id="new-deck"
              disabled={locked}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addDeck();
                }
              }}
            />
          </Field>
          <Button type="button" variant="outline" disabled={!canAddDeck} onClick={addDeck}>
            Add deck
          </Button>
        </div>
      </section>
      <Collapsible className="advanced-settings">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost">
            Advanced settings
            <CaretDownIcon aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="settings-grid">
            {input("text_model", "Text model")}
            {audioProvider !== "woof" && input("tts_model", "Speech model")}
            {audioProvider !== "woof" &&
              input("tts_rpm", "Speech requests per minute", { min: 1, max: 120 })}
            {audioProvider !== "woof" && (
              <Choice
                label="Concurrent speech requests"
                value={String(draft.tts_concurrency)}
                disabled={locked}
                options={[1, 2, 3].map((value) => ({
                  value: String(value),
                  label: String(value),
                }))}
                onChange={(value) => change("tts_concurrency", Number(value))}
              />
            )}
            {input("call_budget", "Audio clip ceiling per run", { min: 4, max: 1000 })}
            {audioProvider !== "woof" &&
              input("estimated_usd_per_word", "Estimated USD per word", {
                min: 0,
                max: 1,
                step: 0.0001,
              })}
          </div>
          <p className="help">
            {audioProvider === "woof"
              ? "A local voice ignores the speech model, quota and concurrency settings, and its clips cost nothing."
              : "Changing the voice or speech model clears audio from the editor. Original clips remain cached."}
          </p>
          <p className="config-location">
            Configuration directory: <code>{configDir}</code>
          </p>
        </CollapsibleContent>
      </Collapsible>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="dialog-footer">
        <Button type="submit" disabled={locked} aria-busy={saving || undefined}>
          {saving && <Spinner />}
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
