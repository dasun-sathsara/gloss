# Sources and licenses

- `src/gloss/assets/jade-glass.css` was copied as a base stylesheet from
  the author's `anki-templates/_themes/jade-glass.css`. Gloss-specific card layout
  rules and its copied dark tokens in `src/gloss/assets/vocabulary.css` are appended by
  `gloss.anki.templates.css()`. Gloss adds a quieter dark palette. The shell,
  fonts, stationary glass layer, edge and divider animations, and answer reveal come from
  that source. The Anki-installed `Eng Vocab 2 Examples` template informed the vocabulary
  content structure. Its older Catppuccin styling is not used.
- The Anki gateway adapts the existing `sync.py` workflow: upload fonts, write the template and
  CSS, then retrieve them to verify. It reads portable bundled/private assets instead of Mac
  font paths. The original template project was not changed.
- Geist Mono and Noto Sans Sinhala keep their OFL license texts in `src/gloss/assets/fonts/`.
- Studio Feixen Sans is a privately supplied font. The local copy is ignored by Git and is not
  included in public packages or the frontend release ZIP.
- Web icons use [Phosphor React](https://github.com/phosphor-icons/react), version 2.1.10,
  with direct per-icon imports. The Anki Play and Stop SVGs are exported from that same package
  by `frontend/scripts/export-card-icons.mjs`; `src/gloss/assets/playback-icons.json` records
  their package version and weight. Copyright (c) 2020 Phosphor Icons; MIT license, retained
  in `src/gloss/assets/licenses/Phosphor-Icons-MIT.txt`.
- Components in `frontend/src/components/ui/` come from the official
  [shadcn/ui registry](https://github.com/shadcn-ui/ui), installed with CLI 4.21.4 using the
  New York style and Radix primitives. Local adjustments cover imports, formatting, error keys,
  strict equality, lint annotations, button geometry, and Phosphor icons.
  Copyright (c) 2023 shadcn; MIT license.

MIT license for the shadcn/ui components:

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Frontend builds include dependency license texts in `THIRD_PARTY_LICENSES.txt`.
The published `react-remove-scroll-bar` package omits its license file. Gloss retains
[the upstream MIT notice](https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE)
in `frontend/licenses/` and includes it in that build notice.
