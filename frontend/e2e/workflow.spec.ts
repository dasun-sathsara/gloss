import { expect, test } from "@playwright/test";

test("compact batch editing, accessible choices, audio, and persistence", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const expectNoOverflow = async () => {
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("body *")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.width > 1 &&
                rect.right > innerWidth + 1 &&
                getComputedStyle(element).position !== "absolute"
              );
            })
            .map((element) => ({
              tag: element.tagName,
              text: element.textContent?.slice(0, 40),
              right: element.getBoundingClientRect().right,
            })),
        ),
      )
      .toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  };
  const expectButtonInsets = async () => {
    const violations = await page.locator("button[data-variant]").evaluateAll((buttons) =>
      buttons.flatMap((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        if (!rect.width || !rect.height) return [];
        const left = Number.parseFloat(style.paddingLeft);
        const right = Number.parseFloat(style.paddingRight);
        const range = document.createRange();
        range.selectNodeContents(button);
        const textRects = [...range.getClientRects()];
        const clipped = textRects.some(
          (text) => text.left < rect.left + 7 || text.right > rect.right - 7,
        );
        return left < 8 || right < 8 || left !== right || clipped
          ? [{ label: button.textContent, left, right, clipped }]
          : [];
      }),
    );
    expect(violations).toEqual([]);
  };
  await page.route("**/api/anki", (route) =>
    route.fulfill({
      json: {
        connected: true,
        ready: true,
        profile: "Test",
        decks: ["Gloss::General", "Gloss::Science"],
      },
    }),
  );
  await page.goto("/");
  expect((await page.request.get("/favicon.svg")).status()).toBe(200);
  await expect(page.locator("link[rel=icon]")).toHaveAttribute("href", "/favicon.svg");
  await page
    .getByRole("textbox", { name: "Words", exact: true })
    .fill("curious\nresilient\ncurious\ninvalidword");
  await expect(page.getByText("3 words", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".word-row")).toHaveCount(3);
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  const curious = page
    .locator(".word-row")
    .filter({ has: page.getByText("curious", { exact: true }) });
  await curious.getByRole("checkbox").uncheck();
  // Choosing a deck affects the batch, including unselected and invalid words.
  const deck = page.getByRole("combobox", { name: "Deck", exact: true });
  expect(await deck.evaluate((element) => element.tagName)).toBe("BUTTON");
  await deck.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("option", { name: "General", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Science", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(deck).toHaveText("Science");
  await expect
    .poll(async () => {
      const cards = (await (await page.request.get("/api/bootstrap")).json()).cards;
      return cards
        .filter((card: { id: string }) => card.id)
        .slice(0, 3)
        .every((card: { deck: string }) => card.deck === "Gloss::Science");
    })
    .toBe(true);
  await curious.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".word-editor");
  const definitionSizes = await curious
    .locator(".definition,.sinhala")
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontSize));
  expect(definitionSizes).toEqual(["14px", "14px"]);
  const editorSizes = await editor
    .locator("textarea[lang]")
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontSize));
  expect(new Set(editorSizes)).toEqual(new Set(["16px"]));
  await expectButtonInsets();
  await expect(editor.getByRole("combobox")).toHaveCount(0);
  await editor
    .getByRole("textbox", { name: "English definition", exact: true })
    .fill("Wanting to find out more about something.");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Advanced settings" }).click();
  await expectButtonInsets();
  const settingsButtonHeights = await page
    .getByRole("dialog")
    .locator("button[data-variant]")
    .evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).height));
  expect(new Set(settingsButtonHeights)).toEqual(new Set(["36px"]));
  await page.getByLabel("Speech requests per minute", { exact: true }).fill("120");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await editor.getByRole("button", { name: "Close editor" }).click();
  await page.getByRole("checkbox", { name: "Select all words", exact: true }).check();
  await page.getByRole("button", { name: "Prepare audio", exact: true }).click();
  await expect(page.getByText("Audio finished.", { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".word-row").getByText("4/4", { exact: true })).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".word-row")).toHaveCount(3);
  await expect(deck).toHaveText("Science");
  await expect(
    page.getByText("Wanting to find out more about something.", { exact: true }),
  ).toBeVisible();
  let pulledIds: string[] = [];
  await page.route("**/api/anki/conflicts", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/anki/pull", (route) => {
    pulledIds = route.request().postDataJSON().ids;
    return route.fulfill({ json: { ticket: "test-ticket", profile: "Test" } });
  });
  let syncPayload: { ids: string[]; ticket: string } | undefined;
  await page.route("**/api/anki/sync", (route) => {
    syncPayload = route.request().postDataJSON();
    return route.fulfill({ json: { id: "test-sync", kind: "sync" } });
  });
  await page.route("**/api/jobs/test-sync/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: done\ndata: {}\n\n",
    }),
  );
  await page.getByRole("button", { name: "Sync to Anki", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Finish syncing in Anki" })).toBeVisible();
  expect(pulledIds).toHaveLength(2);
  await page.getByRole("button", { name: "Sync finished · Save notes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare audio", exact: true })).toBeEnabled();
  expect(syncPayload?.ticket).toBe("test-ticket");
  expect(syncPayload?.ids).toEqual(pulledIds);
  await page.route("**/api/generate", (route) =>
    route.fulfill({ status: 409, json: { detail: "Generation unavailable" } }),
  );
  await page.getByRole("textbox", { name: "Words", exact: true }).fill("record");
  await expect(page.getByText("1 word", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Generation unavailable");
  await expect(page.locator(".word-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 900 });
  expect(await curious.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(
    110,
  );
  const pairedMetrics = await page.locator(".batch-action").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        padding: style.padding,
        borderWidth: style.borderWidth,
        radius: style.borderRadius,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    }),
  );
  expect(pairedMetrics[0]).toEqual(pairedMetrics[1]);
  const headingTops = await page
    .locator(".composer h1,.review-heading h2")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
  expect(Math.abs(headingTops[0] - headingTops[1])).toBeLessThan(1);
  const rowActionTops = await curious
    .locator(".row-actions button")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  expect(rowActionTops[0]).toEqual(rowActionTops[1]);
  await page.setViewportSize({ width: 900, height: 900 });
  await expectNoOverflow();
  await expectButtonInsets();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoOverflow();
  await expectButtonInsets();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expectNoOverflow();
  await curious.getByRole("button", { name: "Edit", exact: true }).click();
  await expectNoOverflow();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectNoOverflow();
  await page.getByRole("button", { name: "Advanced settings" }).click();
  await expectNoOverflow();
  await expectButtonInsets();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await editor.evaluate((element) => parseFloat(getComputedStyle(element).animationDuration)),
  ).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
