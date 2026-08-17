# Style guide — Allen Institute palette

Guidance for anyone (human or agent) touching CSS in `web/styles/` or chart
colours in `web/src/`. The site follows the Allen Institute core color
palettes. **Read this before adding any colour.**

## The palette

### Base (neutrals — structure, text, backgrounds, chart marks)

| Name    | Hex       | RGB           | Use |
|---------|-----------|---------------|-----|
| Black   | `#000000` | 0/0/0         | Text, chart marks, dark-mode surfaces |
| White   | `#FFFFFF` | 255/255/255   | Light-mode page background |
| Page 1  | `#F3F0E8` | 243/240/232   | Light-mode raised/inset layer |
| Page 2  | `#DED9D1` | 222/217/209   | Light-mode second layer / borders |
| Gray 1  | `#AAA39F` | 170/163/159   | Muted text, hairlines (light mode) |
| Gray 2  | `#737373` | 115/115/115   | Dark-mode counterpart of Gray 1 |

### Primary (backgrounds, large fills — "vitality, energy, dynamism")

| Name    | Hex       | RGB           |
|---------|-----------|---------------|
| Blue    | `#6464FF` | 100/100/255   |
| Violet  | `#8246E1` | 130/70/255    |
| Maroon  | `#CD0F55` | 205/15/85     |
| Teal    | `#00A59B` | 0/165/155     |

### Accent (highlights only — never large areas)

| Name    | Hex       | RGB           |
|---------|-----------|---------------|
| Rose    | `#FF00FF` | 255/0/255     |
| Green   | `#CDEB05` | 205/235/5     |
| Orange  | `#FF6E00` | 255/110/0     |
| Ochre   | `#DC9600` | 220/150/0     |
| Yellow  | `#FFEB23` | 255/235/35    |

Backgrounds tend to be primary; accents are highlights.

## Rules for this site

### 1. Charts are black-and-white first

Every chart's default mark colour is **black** (light mode) / **white** (dark
mode) — use `var(--chart-ink)`. Colour appears only where it carries meaning
(a highlighted series, a selection, a threshold).

Accent order when a chart needs colour:

1. **Rose `#FF00FF`** — the default accent. First non-black series, selection,
   "you are here", the highlighted bar.
2. **Teal `#00A59B`** — the second accent / contrast pair with Rose.
3. Anything else only if a third+ category is genuinely required, drawn from
   the primary palette (Violet, Blue, Maroon), never from an ad-hoc hex.

Everything else in the chart — axes, ticks, gridlines, reference lines,
non-focused series — is Gray 1 / Gray 2.

**Do not add new hex literals in chart code.** Read the token off CSS
(`getComputedStyle`) or use `var(--...)` in the mark's fill/stroke; Observable
Plot SVG honours `var()` so the colour flips with the theme without re-render.
See `modalityColor()` in `src/lib/charts.js` for the established pattern.

### 2. Grays layer in a fixed order

Never invent a new gray. Use exactly these layers, in this order from
furthest-back to furthest-forward:

| Token | Light | Dark | Meaning |
|-------|-------|------|---------|
| `--surface-bg`     | White `#FFFFFF` | Black `#000000` | Page background |
| `--surface-card`   | Page 1 `#F3F0E8` | `#1A1A1A` | Cards, panels, table headers |
| `--surface-raised` | Page 2 `#DED9D1` | `#262626` | Nested panel inside a card, hover, inset wells |
| `--surface-border` | Page 2 `#DED9D1` | Gray 2 `#737373` | Hairlines, dividers |
| `--text-primary`   | Black | White | Body text |
| `--text-muted`     | Gray 1 `#AAA39F` | Gray 2 `#737373` | Secondary/muted text |

Page 1 and Page 2 are *layering* tools — not semantic states. Gray 2 is the
dark-mode form of Gray 1; the two never appear in the same theme for the same
purpose.

### 3. Status colours

Keep semantic status meanings but source them from the palette rather than
Bootstrap-ish leftovers:

- error / fail → Maroon `#CD0F55`
- warning / pending → Ochre `#DC9600`
- success / pass → Teal `#00A59B` (Accent Green `#CDEB05` is too hot for fills;
  use it only as a small highlight)

## Current gaps (work still to do)

Findings from a sweep of `web/styles/partials/*.css` and chart code:

1. **Off-palette indigo `#4338ca`** appears ~29 times across
   `06-contributions-core.css`, `08-sessions-qc-project.css`,
   `10-contributions-pages.css`, `13-viewers-misc.css`,
   `16-sessions-log.css`. This is the de-facto accent today. Replace with
   Rose (highlight) or Violet `#8246E1` (large fill).
2. **`--color-red: #c0392b`** (18 uses) is a brick red not in the palette →
   Maroon `#CD0F55`.
3. **`--accent: #3b82f6`** and stray `#2563eb` / `#0078d4` blues → Primary Blue
   `#6464FF`, or drop entirely in favour of Rose.
4. **Ad-hoc grays**: `#6a6a6a` (38), `#e1e1e1`, `#e5e7eb`, `#6b7280`, `#ccc`,
   `#e4e4e4`, `#ddd`, `#f0f0f0`, `#f8f9fa`, `#dee2e6`, `#f3f4f6`, `#f9fafb`…
   All should collapse onto the six-token layer stack above. Light-mode surfaces
   should shift off pure `#f5f5f5` onto warm Page 1 / Page 2.
5. **`AIND_COLORS` in `src/constants.js`** still carries `dark_blue: #111111`,
   `light_blue: #555555`, `red: #c0392b` — neutral stand-ins for an older brand.
   Retire in favour of palette tokens.
6. **`MODALITY_COLOR` in `src/lib/charts.js`** is a Tableau-20 ramp — entirely
   off-brand. It's a legitimately large categorical set, so it's the one place a
   ramp is defensible, but it should be regenerated from the primary + accent
   palettes with `behavior` staying black/white via `--modality-behavior`.
7. **`--color-green: #1D8649`** (16 uses) → Teal `#00A59B`.

## How to migrate

Do it token-first, not file-first:

1. Add the palette as raw tokens in `partials/01-base.css`
   (`--ai-black`, `--ai-page-1`, `--ai-gray-1`, `--ai-rose`, `--ai-teal`, …)
   under `:root`, identical in both themes.
2. Redefine the existing semantic tokens (`--surface-card`, `--accent`,
   `--color-red`, …) in terms of the raw tokens, per theme. This alone
   re-skins most of the site.
3. Then sweep the partials replacing hex literals with the semantic tokens,
   one partial per commit so regressions are bisectable.
4. Charts last: switch defaults to `--chart-ink`, then re-point highlights to
   Rose/Teal.

Never skip to step 3 — hex-hunting without tokens just relocates the problem.
