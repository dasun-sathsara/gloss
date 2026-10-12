import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

function fixture(...flags: string[]) {
  return JSON.parse(
    execFileSync("uv", ["run", "python", "scripts/card_fixture.py", ...flags], {
      cwd: "..",
      encoding: "utf8",
    }),
  ) as { front: string; back: string; css: string };
}

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

test("Anki cards keep a consistent scale and manual audio buttons", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let current = fixture("--legacy-audio");
  let side: "front" | "back" = "front";
  await page.route("**/card-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${current.css.replaceAll('url("_', 'url("/assets/fonts/_')}</style></head><body class="card"><div id="qa">${current[side]}</div></body></html>`,
    }),
  );
  await page.route("**/gloss_*.mp3", (route) =>
    route.fulfill({ contentType: "audio/wav", body: tone() }),
  );
  await page.goto("/card-fixture");
  await expect(page.getByText("resilient", { exact: true })).toBeVisible();
  await expect(page.locator("audio,.gloss-play")).toHaveCount(0);
  await expect(page.locator(".gloss-deck")).toHaveText("Vocabulary");
  side = "back";
  await page.reload();
  await expect(page.getByRole("button", { name: "Play word audio", exact: true })).toBeVisible();
  await expect(page.locator(".gloss-word-audio .gloss-play-icon")).toBeVisible();
  await expect(page.locator("audio[controls],audio[autoplay]")).toHaveCount(0);
  await expect(page.locator(".gloss-play")).toHaveCount(4);
  expect(
    await page
      .locator("audio")
      .evaluateAll((clips) => clips.every((clip) => (clip as HTMLAudioElement).paused)),
  ).toBe(true);
  const play = page.getByRole("button", { name: "Play definition audio", exact: true });
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await expect(play.locator('svg[data-icon="stop"]')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("audio")
        .first()
        .evaluate((clip) => (clip as HTMLAudioElement).currentTime),
    )
    .toBeGreaterThan(0);
  const example = page.getByRole("button", { name: "Play example 1 audio", exact: true });
  await example.focus();
  await page.keyboard.press("Space");
  await expect(example).toHaveAttribute("aria-pressed", "true");
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() =>
      page
        .locator("audio")
        .evaluateAll((clips) => clips.filter((clip) => !(clip as HTMLAudioElement).paused).length),
    )
    .toBe(1);
  await page.keyboard.press("Space");
  await expect(example).toHaveAttribute("aria-pressed", "false");
  // Anki replaces #qa inside the same webview when the next card is shown.
  await play.click();
  const previousClip = await page.locator("audio").first().elementHandle();
  await page.evaluate((front) => {
    const qa = document.querySelector("#qa");
    if (!qa) throw new Error("Missing Anki content wrapper");
    qa.innerHTML = front;
    for (const script of qa.querySelectorAll("script")) {
      const replacement = document.createElement("script");
      replacement.textContent = script.textContent;
      script.replaceWith(replacement);
    }
  }, current.front);
  expect(await previousClip?.evaluate((clip) => (clip as HTMLAudioElement).paused)).toBe(true);
  await page.reload();
  for (const width of [1280, 720, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const metrics = await page.evaluate(() => {
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        buttons: [...document.querySelectorAll(".gloss-play")].map((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return [rect.width, rect.height, style.paddingLeft, style.paddingRight];
        }),
      };
    });
    expect(metrics.overflow).toBe(false);
    expect(new Set(metrics.buttons.map((button) => JSON.stringify(button))).size).toBe(1);
  }
  current = fixture("--long", "--missing-audio");
  await page.reload();
  await expect(page.locator(".gloss-play")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const darkBackground = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  await page.evaluate(() => document.body.classList.add("nightMode"));
  expect(
    await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
  ).toBe(darkBackground);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  expect(
    await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
  ).toBe(darkBackground);
  expect(
    await page
      .locator(".gloss-card")
      .evaluate((card) => getComputedStyle(card, "::before").animationName),
  ).toBe("none");
  expect(errors).toEqual([]);
});
