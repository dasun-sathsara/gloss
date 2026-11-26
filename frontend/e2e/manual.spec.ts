import { expect, test } from "@playwright/test";
import type { Bootstrap, Card, ManualRun } from "../src/lib";

const row = (index: number, word: string) => ({
  index,
  source_word: word,
  valid: true,
  word,
  pos: "adjective",
  meaning: "A short definition.",
  sinhala: "අර්ථය",
  example1: "Here is an example.",
  example2: "Here is a second sentence.",
  reason: "",
});

test("manual batches validate, resume, and stay in review", async ({ page }) => {
  const run = async () => {
    const { manual } = (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
    if (!manual) throw new Error("No active manual run");
    return manual;
  };

  await page.route("**/api/anki", (route) =>
    route.fulfill({ json: { connected: false, ready: false, decks: [] } }),
  );
  const textRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(text\/warm|generate)$/.test(request.url())) textRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Search words" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare audio" })).toHaveCount(0);
  await page.getByLabel("Words", { exact: true }).fill("curious\nresilient\npatient");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  await expect(page.getByRole("combobox", { name: "Generation mode" })).toHaveText(
    "Manual copy & paste",
  );
  const size = page.getByLabel("Words per manual batch");
  await expect(size).toHaveValue("25");
  await size.fill("2");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).not.toBeVisible();
  await expect(page.getByText("2 batches · up to 2 words each")).toBeVisible();
  await expect(page.getByLabel("Words per manual batch")).toHaveCount(0);
  await expect(page.getByText("Customize prompts", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Start manual generation" }).click();
  await expect(page.getByRole("heading", { name: "Batch 1 of 2", exact: true })).toBeVisible();
  await expect(page.getByText("Change remaining batch size")).toHaveCount(0);
  await page.getByRole("button", { name: "View prompt" }).click();
  await expect(page.getByLabel("Prompt text")).toHaveValue(/Teach English to a Sinhala-speaking/);
  const first = await run();
  const reply = page.getByLabel("JSON reply");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("Denied")) },
    });
  });
  await page.getByRole("button", { name: "Copy full prompt" }).click();
  await expect(
    page.getByText("Gloss couldn't copy the prompt. Copy it from the box below."),
  ).toBeVisible();
  await expect(page.getByLabel("Prompt text")).toBeFocused();
  await reply.fill(first.full_prompt);
  await page.getByRole("button", { name: "Validate and continue" }).click();
  await expect(
    page.getByText("You pasted the prompt. Copy the reply from Gemini instead."),
  ).toBeVisible();
  await expect(reply).toHaveValue(first.full_prompt);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.reject(new Error("Clipboard permission denied")) },
    });
  });
  await page.getByRole("button", { name: "Paste reply" }).click();
  await expect(page.getByText("Paste the reply into the box below.")).toBeVisible();
  await expect(page.getByLabel("JSON reply")).toBeFocused();
  await page
    .getByLabel("JSON reply")
    .fill(JSON.stringify({ batch: first.code, items: [row(1, "curious")] }));
  await page.getByRole("button", { name: "Validate and continue" }).click();
  await expect(page.getByText("Missing row 2: resilient.")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          if (
            !value.includes("complete replacement reply") ||
            !value.includes("Missing row 2: resilient.")
          )
            throw new Error("Unexpected prompt");
          return Promise.resolve();
        },
      },
    });
  });
  await page.getByRole("button", { name: "Copy correction prompt" }).click();
  await expect(page.getByText("Correction prompt copied.")).toBeVisible();
  await expect(reply).toBeFocused();
  await expect(page.getByText("No words in this batch.")).toBeVisible();
  await page.evaluate(
    (value) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: () => Promise.resolve(value) },
      });
    },
    "```json\n" +
      JSON.stringify({
        batch: first.code,
        items: [row(1, "curious"), row(2, "resilient")],
      }) +
      "\n```",
  );
  await page.getByRole("button", { name: "Paste reply" }).click();
  await expect(page.getByLabel("JSON reply")).toHaveValue(/resilient/);
  await page.getByRole("button", { name: "Validate and continue" }).click();
  await expect(page.getByRole("heading", { name: "Batch 2 of 2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy continuation prompt" })).toBeFocused();
  await expect(reply).toHaveValue("");
  await reply.fill(JSON.stringify({ batch: first.code, items: [row(1, "curious")] }));
  await page.getByRole("button", { name: "Validate and finish" }).click();
  await expect(page.getByText(/This reply is for another batch/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy correction prompt" })).toHaveCount(0);
  await page.getByLabel("JSON reply").fill("unfinished reply");
  await page.reload();
  await expect(page.getByLabel("JSON reply")).toHaveValue("unfinished reply");
  await expect(page.getByText("Gloss imported 2 of 3 words.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy continuation prompt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy full prompt" })).toBeVisible();
  await page.getByRole("button", { name: "View prompt" }).click();
  const prompt = page.getByLabel("Prompt text");
  await expect(prompt).toHaveValue(/Use the same card-writing instructions/);
  await expect(prompt).not.toHaveValue(/Teach English to a Sinhala-speaking/);
  const second = await run();
  await page.getByLabel("JSON reply").fill(
    JSON.stringify({
      batch: second.code,
      items: [row(1, "patient")],
    }),
  );
  await page.getByRole("button", { name: "Validate and finish" }).click();
  await expect(page.getByText("3 words imported.")).toBeVisible();
  expect(textRequests).toEqual([]);
  await expect(page.getByText("Local draft", { exact: true }).first()).toBeVisible();
  const done = await run();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start manual generation" })).toBeVisible();
  await settings.click();
  await expect(size).toHaveValue("2");
  await size.fill("25");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).not.toBeVisible();
  // The suite shares one test server; leave the library clean for the automatic workflow test.
  for (const id of done.card_ids) {
    const response = await page.request.delete(`/api/cards/${id}`, {
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(response.ok()).toBe(true);
  }
});

test("automatic generation is unavailable without a text provider", async ({ page }) => {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as Bootstrap;
    await route.fulfill({ response, json: { ...state, provider_ready: false, text_provider: "" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const mode = page.getByRole("combobox", { name: "Generation mode" });
  await expect(mode).toHaveText("Manual copy & paste");
  await mode.click();
  await expect(page.getByRole("option", { name: "Automatic (not configured)" })).toBeDisabled();
});

test("restoring a manual run never selects unrelated library drafts", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("No Gloss test server");
  const headers = { Origin: baseURL };
  let current: ManualRun | null = null;
  const draftIds: string[] = [];

  const start = async (deck: string, text: string) => {
    const response = await page.request.post("/api/manual", { headers, data: { deck, text } });
    expect(response.ok()).toBe(true);
    current = (await response.json()) as ManualRun;
    return current;
  };
  const save = async (run: ManualRun, words: string[]) => {
    const response = await page.request.post("/api/manual/import", {
      headers,
      data: {
        reply: JSON.stringify({ batch: run.code, items: words.map((word, i) => row(i + 1, word)) }),
      },
    });
    expect(response.ok()).toBe(true);
    const result = (await response.json()) as { manual: ManualRun; cards: Card[] };
    current = result.manual;
    draftIds.push(...result.cards.map((card) => card.id));
    return result;
  };
  const close = async (run: ManualRun) => {
    const response = await page.request.delete(`/api/manual/${run.code}`, { headers });
    expect(response.ok()).toBe(true);
    current = null;
  };

  try {
    const general = await start("Gloss::General", "unrelated");
    const older = await save(general, ["unrelated"]);
    await close(older.manual);
    const other = await start("Gloss::Other", "retained\nnotretained");
    const sameDeck = await save(other, ["retained", "notretained"]);
    await close(sameDeck.manual);
    const pending = await start("Gloss::Other", "fresh");
    await page.route("**/api/anki", (route) =>
      route.fulfill({
        json: { connected: true, ready: true, decks: ["Gloss::General", "Gloss::Other"] },
      }),
    );

    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Deck", exact: true })).toHaveText("Other");
    await expect(page.getByText("No words in this batch.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync to Anki" })).toHaveCount(0);

    await page.evaluate(
      (ids) => localStorage.setItem("gloss-batch", JSON.stringify(ids)),
      [older.cards[0].id, sameDeck.cards[0].id],
    );
    await page.reload();
    await expect(page.locator(".word-row")).toHaveCount(1);
    await expect(page.locator(".word-row")).toContainText("retained");
    await expect(page.locator(".word-row")).not.toContainText("notretained");

    await save(pending, ["fresh"]);
    await page.reload();
    await expect(page.locator(".word-row")).toHaveCount(2);
    await expect(page.locator(".word-row").getByText("fresh", { exact: true })).toBeVisible();
    const { cards } = (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
    expect(cards.find((card) => card.id === older.cards[0].id)?.deck).toBe("Gloss::General");
  } finally {
    if (current) await close(current);
    for (const id of draftIds) {
      const response = await page.request.delete(`/api/cards/${id}`, { headers });
      expect(response.ok()).toBe(true);
    }
  }
});

test("exact repeats preserve case, distinct hints and order on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const add = await page.locator(".composer").boundingBox();
  const review = await page.locator(".review-section").boundingBox();
  expect(add && review && review.y >= add.y + add.height).toBeTruthy();
  const words = page.getByRole("textbox", { name: "Words", exact: true });
  await words.fill(
    "bank: finance; bank: river; Bank: finance; bank: finance; café; cafe; bank account",
  );
  await expect(page.getByText("7 words", { exact: true })).toBeVisible();
  await expect(page.getByText("bank: Duplicate entry", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove duplicates" }).click();
  await expect(words).toHaveValue(
    "bank: finance\nbank: river\nBank: finance\ncafé\ncafe\nbank account",
  );
  await expect(page.getByText("6 words", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start manual generation" }).click();
  await page.getByLabel("JSON reply").fill("discard this draft");
  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.getByRole("button", { name: "End run" }).click();
  await words.fill("next");
  await page.getByRole("button", { name: "Start manual generation" }).click();
  await page.reload();
  await expect(page.getByLabel("JSON reply")).toHaveValue("");
  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.getByRole("button", { name: "End run" }).click();
  await expect(words).toBeVisible();
});
