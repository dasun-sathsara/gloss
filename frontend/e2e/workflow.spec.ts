import { expect, test } from "@playwright/test";

function tone() {
  const rate = 8000;
  const samples = rate * 3;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    wav.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * Math.PI * 2) * 1000), 44 + i * 2);
  }
  return wav;
}

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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Generation mode" }).click();
  await page.getByRole("option", { name: "Automatic generation" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  expect((await page.request.get("/favicon.svg")).status()).toBe(200);
  await page
    .getByRole("textbox", { name: "Words", exact: true })
    .fill("curious\nresilient\ncurious\ninvalidword");
  await page.getByRole("button", { name: "Remove duplicates" }).click();
  await expect(page.getByText("3 words", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".word-row")).toHaveCount(3);
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  // Audio records in the same run. No second click is needed.
  await expect(
    page.getByText("Added 3 words. 1 card needs review. Audio is ready.", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".word-row").getByText("4/4", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: "Words", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Prepare audio", exact: true })).toBeDisabled();
  const curious = page
    .locator(".word-row")
    .filter({ has: page.getByText("curious", { exact: true }) });
  await curious.getByRole("checkbox").uncheck();
  // Choosing a deck affects the batch, including unselected and invalid words.
  const deck = page.getByRole("combobox", { name: "Deck", exact: true });
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
  await expectButtonInsets();
  await editor
    .getByRole("textbox", { name: "English definition", exact: true })
    .fill("Wanting to find out more about something.");
  await expect(curious.getByText("3/4", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor.getByRole("button", { name: "Save changes" })).toBeDisabled();
  // Saving the edit re-records only the changed clip.
  await expect(curious.getByText("4/4", { exact: true })).toBeVisible({ timeout: 20000 });
  const example1Field = editor.getByRole("textbox", { name: "Example 1", exact: true });
  const originalExample1 = await example1Field.inputValue();
  await example1Field.fill("Temporary unsaved example.");
  await expect(
    curious.locator(".status-column").getByText("Unsaved", { exact: true }),
  ).toBeVisible();
  const playWord = editor.getByRole("button", { name: "Play word audio", exact: true });
  const mediaHandler = (route: Parameters<Parameters<typeof page.route>[1]>[0]) =>
    route.fulfill({ contentType: "audio/wav", body: tone() });
  await page.route("**/media/gloss_*.mp3", mediaHandler);
  await playWord.click();
  const stopWord = editor.getByRole("button", { name: "Stop word audio", exact: true });
  await expect(stopWord).toBeVisible();
  await expect(example1Field).toHaveValue("Temporary unsaved example.");
  await expect(editor.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await stopWord.click();
  await expect(playWord).toBeVisible();
  await page.unroute("**/media/gloss_*.mp3", mediaHandler);
  await editor.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(example1Field).toHaveValue(originalExample1);
  await expect(editor.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Advanced settings" }).click();
  await expectButtonInsets();
  await expect(page.getByRole("combobox", { name: "Audio engine" })).toHaveText("Woof (local)");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await editor.getByRole("button", { name: "Close editor" }).click();
  await page.getByRole("checkbox", { name: "Select all words", exact: true }).check();
  await expect(page.getByRole("button", { name: "Prepare audio", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const invalid = page
    .locator(".word-row")
    .filter({ has: page.getByText("invalidword", { exact: true }) });
  await invalid.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Remove this word?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".word-row")).toHaveCount(3);
  await expect(page.locator(".word-row").getByText("4/4", { exact: true })).toHaveCount(2);
  await invalid.getByRole("button", { name: "Edit", exact: true }).click();
  const verifyBox = page.getByRole("checkbox", {
    name: "I checked this card and filled in all its fields.",
    exact: true,
  });
  await verifyBox.check();
  await expect(verifyBox).toBeVisible();
  await page.locator(".word-editor").getByRole("button", { name: "Discard", exact: true }).click();
  await page
    .locator(".word-editor")
    .getByRole("button", { name: "Close editor", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const mode = page.getByRole("combobox", { name: "Generation mode" });
  await expect(mode).toHaveText("Manual copy & paste");
  await mode.click();
  await page.getByRole("option", { name: "Automatic generation" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".word-row")).toHaveCount(3);
  await expect(deck).toHaveText("Science");
  await expect(
    page.getByText("Wanting to find out more about something.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search words" }).fill("curious");
  await expect(page.getByText(/This filter hides 1 selected card/)).toBeVisible();
  await page.getByRole("button", { name: "Select visible only" }).click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search words" }).clear();
  await page.getByRole("checkbox", { name: "Select resilient" }).check();
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
  let syncEvents = 0;
  let retryProfile: string | undefined;
  await page.route("**/api/anki/conflicts", (route) => {
    retryProfile = route.request().postDataJSON().expected_profile;
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/jobs/test-sync/events", async (route) => {
    const [saved, failed] = pulledIds;
    const state = await page.request.get("/api/bootstrap").then((response) => response.json());
    const sent = state.cards.find((card: { id: string }) => card.id === saved);
    const events: [string, unknown][] =
      syncEvents++ === 0
        ? [
            [
              "sync_remaining",
              { saved: 1, ids: [failed], profile: "Test", decks: { [failed]: "Gloss::Science" } },
            ],
            ["failed", { message: "Anki stopped." }],
          ]
        : [["card", { ...sent, note_id: 123, synced_hash: "confirmed" }]];
    expect(saved).toBeTruthy();
    return route.fulfill({
      contentType: "text/event-stream",
      body: events
        .concat([["done", {}]])
        .map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
        .join(""),
    });
  });
  const heading = page.locator(".review-heading");
  const headingY = (await heading.boundingBox())!.y;
  await page.getByRole("button", { name: "Sync to Anki", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Finish syncing in Anki" })).toBeVisible();
  expect(pulledIds).toHaveLength(2);
  await page.getByRole("button", { name: "Save notes to Anki", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync to Anki", exact: true })).toBeDisabled();
  expect(syncPayload?.ticket).toBe("test-ticket");
  expect(syncPayload?.ids).toEqual(pulledIds);
  const failedId = pulledIds[1];
  await expect(page.getByText(/Gloss saved 1 card in Anki under "Test"/)).toBeVisible();
  const ankiErrorToast = page.locator("[data-sonner-toast]").filter({ hasText: "Anki stopped." });
  await expect(ankiErrorToast).toHaveAttribute("data-type", "error");
  expect(Math.abs((await heading.boundingBox())!.y - headingY)).toBeLessThan(1);
  await page.getByRole("button", { name: "Retry remaining cards" }).click();
  await expect(page.getByRole("dialog", { name: "Finish syncing in Anki" })).toBeVisible();
  expect(retryProfile).toBe("Test");
  expect(pulledIds).toEqual([failedId]);
  await expect(page.getByText(/Send 1 card.*Gloss::Science/)).toBeVisible();
  await page.getByRole("button", { name: "Save notes to Anki", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry remaining cards" })).toHaveCount(0);
  expect(syncPayload?.ids).toEqual([failedId]);
  await page.route("**/api/generate", (route) =>
    route.fulfill({ status: 409, json: { detail: "Generation unavailable" } }),
  );
  await page.getByRole("textbox", { name: "Words", exact: true }).fill("record");
  await expect(page.getByText("1 word", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const failureToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Generation unavailable" });
  await expect(failureToast).toBeVisible();
  await expect(page.locator(".word-row")).toHaveCount(3);
  await failureToast.getByRole("button", { name: "Close toast" }).click();
  await expect(failureToast).toHaveCount(0);
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
  const review = page.locator(".review-section");
  const interfaceFonts = await page
    .locator("body, .brand, .composer h1, .review-heading h2, .word-name")
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontFamily));
  expect(interfaceFonts[0]).toContain("Feixen");
  expect(new Set(interfaceFonts).size).toBe(1);
  const workspaceFrame = page.locator(".batch-layout");
  await expect(page.locator(".app-shell")).toHaveCSS("border-top-width", "0px");
  const expectViewportFit = async () => {
    const measurements = await workspaceFrame.evaluate((frame) => {
      const shell = frame.closest(".app-shell")!.getBoundingClientRect();
      const layout = frame.getBoundingClientRect();
      return {
        left: shell.left,
        rightGap: innerWidth - shell.right,
        bottomGap: innerHeight - layout.bottom,
        composerBottomGap:
          layout.bottom - frame.querySelector(".composer")!.getBoundingClientRect().bottom,
      };
    });
    for (const gap of Object.values(measurements)) expect(Math.abs(gap)).toBeLessThan(1);
  };
  await expectViewportFit();
  await expect(workspaceFrame).toHaveCSS("border-top-width", "0px");
  const chromeGap = await page
    .locator(".app-shell")
    .evaluate(
      (shell) =>
        shell.querySelector(".workspace")!.getBoundingClientRect().top -
        shell.querySelector(".app-header")!.getBoundingClientRect().bottom,
    );
  expect(Math.abs(chromeGap)).toBeLessThan(1);
  await expect(workspaceFrame.locator(".composer")).toHaveCSS("border-right-width", "1px");
  await expect(review).toHaveCSS("border-top-width", "0px");
  await expect(review).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  for (const width of [1600, 1050, 900, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await expectViewportFit();
    await expectNoOverflow();
    await expectButtonInsets();
    const buttons = await review.locator(".bulk-actions button").evaluateAll((elements) =>
      elements.map((element) => {
        const { top, width, height } = element.getBoundingClientRect();
        return { top, width, height };
      }),
    );
    for (const button of buttons.slice(1)) {
      expect(button.top).toEqual(buttons[0].top);
      expect(button.height).toEqual(buttons[0].height);
      expect(Math.abs(button.width - buttons[0].width)).toBeLessThan(1);
    }
    const widths = await curious.locator(".meaning-column").evaluate((element) => ({
      cell: element.getBoundingClientRect().width,
      panel: element.closest(".review-section")!.getBoundingClientRect().width,
    }));
    expect(widths.cell).toBeGreaterThan(widths.panel * 0.25);
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const dialogAlignment = await settings.evaluate((dialog) => {
    const centerY = (selector: string) => {
      const rect = dialog.querySelector(selector)!.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    return Math.abs(centerY('[data-slot="dialog-title"]') - centerY('[data-slot="dialog-close"]'));
  });
  expect(dialogAlignment).toBeLessThan(1);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
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
