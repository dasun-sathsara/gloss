import { useState } from "react";
import type { AnkiStatus, Preferences } from "../lib";
import { Choice } from "./Choice";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

export function Settings({
  settings,
  voices,
  configDir,
  anki,
  onSave,
  onAddDeck,
  busy,
}: {
  settings: Preferences;
  voices: string[];
  configDir: string;
  anki: AnkiStatus;
  onSave: (preferences: Preferences) => Promise<void>;
  onAddDeck: (name: string) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(settings);
  const [subjects, setSubjects] = useState(settings.seed_decks.join(", "));
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const change = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const locked = busy || saving;
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
        value={String(draft[key])}
        onChange={(event) => change(key, numeric ? Number(event.target.value) : event.target.value)}
      />
    </Field>
  );
  return (
    <form
      className="settings-body"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          await onSave({
            ...draft,
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
        <Choice
          label="Voice"
          value={draft.voice}
          disabled={locked}
          options={voices.map((value) => ({ value, label: value }))}
          onChange={(value) => change("voice", value)}
        />
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
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={
              locked ||
              !anki.connected ||
              !name.trim() ||
              draft.deck_parent !== settings.deck_parent
            }
            onClick={async () => {
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
            }}
          >
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
            {input("tts_model", "Speech model")}
            {input("tts_rpm", "Speech requests per minute", { min: 1, max: 120 })}
            <Choice
              label="Concurrent speech requests"
              value={String(draft.tts_concurrency)}
              disabled={locked}
              options={[1, 2, 3].map((value) => ({ value: String(value), label: String(value) }))}
              onChange={(value) => change("tts_concurrency", Number(value))}
            />
            {input("call_budget", "Audio request ceiling per run", { min: 4, max: 1000 })}
            {input("estimated_usd_per_word", "Estimated USD per word", { min: 0, step: 0.0001 })}
          </div>
          <p className="help">
            Changing the voice or speech model clears audio from the editor. Original clips remain
            cached.
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
        <Button type="submit" disabled={locked}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}

import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
