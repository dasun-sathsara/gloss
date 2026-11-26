import { expect, test } from "@playwright/test";
import type { Bootstrap } from "../src/lib";

test("manual batches validate, resume, and stay in review", async ({ page }) => {
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
  const run = async () => {
    const { manual } = (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
    if (!manual) throw new Error("No active manual run");
    return manual;
  };

  await page.route("**/api/anki", (route) =>
    route.fulfill({ json: { connected: false, ready: false, decks: [] } }),
  );
  await page.goto("/");
  await page.getByRole("combobox", { name: "Generation mode" }).click();
  await page.getByRole("option", { name: "Manual copy & paste" }).click();
  await page.getByLabel("Words", { exact: true }).fill("curious\nresilient\npatient");
  await page.getByLabel("Words per prompt").fill("2");
  await page.getByText("Customize prompts", { exact: true }).click();
  await page.getByLabel("New chat instructions").fill("Define words in plain English.");
  await page.getByLabel("Same chat instructions").fill("Continue in the same style.");
  await page.getByRole("button", { name: "Create manual batches" }).click();
  await expect(page.getByRole("heading", { name: "Batch 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View prompt" }).click();
  await expect(page.getByLabel("Prompt text")).toHaveValue(/Define words in plain English/);
  const first = await run();
  await page.getByLabel("JSON reply").fill(
    JSON.stringify({
      batch: first.code,
      items: [row(1, "curious")],
    }),
  );
  await page.getByRole("button", { name: "Validate and continue" }).click();
  await expect(page.getByText("Missing rows: 2.")).toBeVisible();
  await expect(page.getByText("No words in this batch.")).toBeVisible();
  await page.getByLabel("JSON reply").fill(
    "```json\n" +
      JSON.stringify({
        batch: first.code,
        items: [row(1, "curious"), row(2, "resilient")],
      }) +
      "\n```",
  );
  await page.getByRole("button", { name: "Validate and continue" }).click();
  await expect(page.getByRole("heading", { name: "Batch 2", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("2 of 3 words imported")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy continuation prompt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy full prompt" })).toBeVisible();
  await page.getByRole("button", { name: "View prompt" }).click();
  const prompt = page.getByLabel("Prompt text");
  await expect(prompt).toHaveValue(/Continue in the same style/);
  await expect(prompt).not.toHaveValue(/Define words in plain English/);
  const second = await run();
  await page.getByLabel("JSON reply").fill(
    JSON.stringify({
      batch: second.code,
      items: [row(1, "patient")],
    }),
  );
  await page.getByRole("button", { name: "Validate and finish" }).click();
  await expect(page.getByText("3 words imported.")).toBeVisible();
  const done = await run();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create manual batches" })).toBeVisible();
  // The suite shares one test server; leave the library clean for the automatic workflow test.
  for (const id of done.card_ids) {
    const response = await page.request.delete(`/api/cards/${id}`, {
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(response.ok()).toBe(true);
  }
});
