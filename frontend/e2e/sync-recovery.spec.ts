import { expect, test } from "@playwright/test";
import type { Bootstrap, Card, SyncRecovery } from "../src/lib";

const shortDeck = "Gloss::General";
const longDeck = "Gloss::" + "x".repeat(80);

function card(id: string, deck: string, withAudio = false): Card {
  return {
    id,
    deck,
    word: id,
    source_word: id,
    hint: "",
    pos: "noun",
    meaning: "A short definition.",
    sinhala: "අර්ථය",
    example1: "One example.",
    example2: "Another example.",
    valid: true,
    reason: "",
    decision: "ask",
    audio: withAudio
      ? { word: "test.mp3", meaning: "test.mp3", example1: "test.mp3", example2: "test.mp3" }
      : {},
    audio_errors: {},
    synced_hash: "",
    note_id: null,
    order: 0,
  };
}

test("terminal disconnect and reload restore the scoped Anki retry", async ({ page }) => {
  const saved = { ...card("saved", shortDeck, true), note_id: 12 };
  const unsent = card("unsent", longDeck);
  const recovery: SyncRecovery = {
    id: "pending",
    ids: [unsent.id],
    decks: { [unsent.id]: unsent.deck },
    profile: "Learner",
    saved: 1,
  };
  let active = true;
  let profile = "Other";
  let syncScope: unknown;
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as Bootstrap;
    await route.fulfill({
      json: {
        ...state,
        cards: [saved, unsent],
        card_count: 2,
        manual: null,
        active_job: active ? { id: "pending", kind: "sync", stage: "sync" } : null,
        sync_recovery: active ? null : recovery,
      },
    });
  });
  await page.route("**/api/jobs/pending/events", async (route) => {
    active = false;
    await route.abort();
  });
  await page.route("**/api/anki", (route) =>
    route.fulfill({
      json: { connected: true, ready: true, profile, decks: [shortDeck, longDeck] },
    }),
  );
  await page.route("**/api/anki/conflicts", (route) => {
    syncScope = route.request().postDataJSON();
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/anki/pull", (route) =>
    route.fulfill({ json: { ticket: "scope-ticket", profile } }),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText(/Gloss lost the connection to this run/)).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry remaining cards" });
  await expect(retry).toBeDisabled();
  await expect(page.locator(".anki-recovery")).toContainText(longDeck);
  await expect(page.getByRole("button", { name: "Sync to Anki", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.reload();
  await expect(retry).toBeDisabled();
  await expect(page.getByText(/Switch to Learner in Anki/)).toBeVisible();

  profile = "Learner";
  await page.reload();
  await expect(retry).toBeEnabled();
  await retry.click();
  expect(syncScope).toEqual({
    ids: [unsent.id],
    expected_profile: "Learner",
    recovery_id: recovery.id,
  });
  await expect(page.getByRole("dialog", { name: "Finish syncing in Anki" })).toContainText(
    longDeck,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("audio consent follows the confirmed scope after reconnecting to conflicts", async ({
  page,
}) => {
  const selected = card("selected", shortDeck, true);
  const target = card("target", longDeck);
  await page.addInitScript(() => localStorage.setItem("gloss-batch", JSON.stringify(["selected"])));
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as Bootstrap;
    await route.fulfill({
      json: {
        ...state,
        cards: [selected, target],
        card_count: 2,
        manual: null,
        active_job: { id: "conflict", kind: "sync", stage: "sync" },
        sync_recovery: null,
      },
    });
  });
  await page.route("**/api/anki", (route) =>
    route.fulfill({
      json: { connected: true, ready: true, profile: "Learner", decks: [shortDeck, longDeck] },
    }),
  );
  const events: [string, unknown][] = [
    ["sync_scope", { ids: [target.id], profile: "Learner" }],
    [
      "conflicts",
      [{ id: target.id, word: target.word, kind: "anki", existing: [{ meaning: "Old" }] }],
    ],
    ["done", {}],
  ];
  await page.route("**/api/jobs/conflict/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
        .join(""),
    }),
  );
  await page.route("**/api/cards/target", (route) =>
    route.fulfill({ json: { ...target, ...route.request().postDataJSON() } }),
  );
  await page.route("**/api/anki/pull", (route) => {
    expect(route.request().postDataJSON().ids).toEqual([target.id]);
    return route.fulfill({ json: { ticket: "confirmed", profile: "Learner" } });
  });

  await page.goto("/");
  const conflict = page.getByRole("dialog", { name: "Resolve duplicate meanings" });
  await conflict.getByRole("combobox").click();
  await page.getByRole("option", { name: "Keep both meanings" }).click();
  await conflict.getByRole("button", { name: "Save choices" }).click();
  const dialog = page.getByRole("dialog", { name: "Finish syncing in Anki" });
  await expect(dialog).toContainText(longDeck);
  const save = dialog.getByRole("button", { name: "Save notes to Anki" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Save without all audio" }).check();
  await expect(save).toBeEnabled();
});
