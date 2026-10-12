import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PlayIcon } from "@phosphor-icons/react/dist/ssr/Play";
import { StopIcon } from "@phosphor-icons/react/dist/ssr/Stop";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const packageFile = require.resolve("@phosphor-icons/react/package.json");
const { version } = JSON.parse(readFileSync(packageFile, "utf8"));
const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/gloss/assets");
const icons = Object.fromEntries(
  Object.entries({ play: PlayIcon, stop: StopIcon }).map(([name, Icon]) => [
    name,
    renderToStaticMarkup(
      createElement(Icon, {
        className: "gloss-play-icon",
        size: 18,
        weight: "regular",
        "aria-hidden": true,
        focusable: false,
        "data-icon": name,
      }),
    ),
  ]),
);
writeFileSync(
  resolve(assets, "playback-icons.json"),
  `${JSON.stringify({ package: "@phosphor-icons/react", version, weight: "regular", icons }, null, 2)}\n`,
);
mkdirSync(resolve(assets, "licenses"), { recursive: true });
writeFileSync(
  resolve(assets, "licenses/Phosphor-Icons-MIT.txt"),
  readFileSync(resolve(dirname(packageFile), "LICENSE")),
);
console.log(`Exported Phosphor ${version} playback icons and license for Anki.`);
