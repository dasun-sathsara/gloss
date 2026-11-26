import { expect, test } from "@playwright/test";
import type { Bootstrap } from "../src/lib";

test("Woof is the default and the voice picker saves Mira", async ({ page }) => {
  const bootstrap = async (): Promise<Bootstrap> =>
    (await page.request.get("/api/bootstrap")).json();
  const initial = await bootstrap();
  const headers = { Origin: "http://127.0.0.1:8777" };
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const voice = page.getByRole("combobox", { name: "Woof voice" });
    const engine = page.getByRole("combobox", { name: "Audio engine" });
    await expect(voice).toHaveText("Juno");
    await expect(page.getByText("Saving removes mismatched clips", { exact: false })).toHaveCount(
      0,
    );
    const setupNote = page.getByText("After saving, open Anki in Gloss and choose Set up Anki.");
    await expect(setupNote).toHaveCount(0);
    const parentDeck = page.getByRole("textbox", { name: "Parent deck" });
    await parentDeck.fill("Other");
    await expect(setupNote).toBeVisible();
    await parentDeck.fill(initial.settings.deck_parent);
    await expect(setupNote).toHaveCount(0);

    await expect(engine).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Google voice" })).toHaveCount(0);
    await voice.click();
    await expect(page.getByRole("option")).toHaveText(["Juno", "Mira"]);
    await page.getByRole("option", { name: "Mira" }).click();
    await expect(page.getByText("Saving removes mismatched clips", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Advanced settings" }).click();
    await expect(engine).toHaveText("Woof (local)");
    await engine.click();
    await expect(
      page.getByRole("option", { name: "Google Cloud (not configured)" }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect.poll(async () => (await bootstrap()).settings.woof_voice).toBe("mira");
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(voice).toHaveText("Mira");
    expect((await bootstrap()).settings.audio_provider).toBe("woof");
  } finally {
    await page.request.put("/api/settings", { headers, data: initial.settings });
  }
});

test("Google speech controls appear only after opting in under Advanced settings", async ({
  page,
}) => {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as Bootstrap;
    await route.fulfill({
      response,
      json: { ...state, google_audio_available: true, voices: ["Kore", "Puck"] },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const voice = page.getByRole("combobox", { name: "Google voice" });
  await expect(voice).toHaveCount(0);
  await page.getByRole("button", { name: "Advanced settings" }).click();
  await expect(voice).toHaveCount(0);
  await page.getByRole("combobox", { name: "Audio engine" }).click();
  await page.getByRole("option", { name: "Google Cloud", exact: true }).click();
  await expect(voice).toHaveText("Kore");
  await expect(page.getByRole("combobox", { name: "Woof voice" })).toHaveCount(0);
  await page.getByRole("button", { name: "Advanced settings" }).click();
  await expect(voice).toHaveCount(0);
});
