import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const packages = Object.values(JSON.parse(readFileSync(0, "utf8"))).flat();
for (const name of ["tailwindcss", "tw-animate-css"]) {
  const directory = resolve("node_modules", name);
  const metadata = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  packages.push({ name, versions: [metadata.version], paths: [directory] });
}
const notices = packages
  .sort((left, right) => left.name.localeCompare(right.name))
  .map(({ name, versions, paths }) => {
    const directory = paths[0];
    const files = readdirSync(directory).filter((file) =>
      /^(license|copying|notice)([.-]|$)/i.test(file),
    );
    if (!files.length) {
      if (name !== "react-remove-scroll-bar") throw new Error(`Missing license notice for ${name}`);
      return `${name} ${versions.join(", ")}\n\n${readFileSync("licenses/react-remove-scroll-bar-MIT.txt", "utf8").trim()}`;
    }
    const text = files
      .map((file) => readFileSync(resolve(directory, file), "utf8").trim())
      .join("\n\n");
    return `${name} ${versions.join(", ")}\n\n${text}`;
  });
writeFileSync(
  "dist/THIRD_PARTY_LICENSES.txt",
  `${notices.join("\n\n----------------------------------------\n\n")}\n`,
);
