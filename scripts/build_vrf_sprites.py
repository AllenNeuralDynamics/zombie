"""Generate the VRF top-down pixel-art sprites used by the animation.

Each sprite is a tiny SVG with 1x1 <rect>s on a fixed viewBox so it can be
scaled arbitrarily without anti-aliasing artefacts. Colours are baked in
(simple, theme-agnostic) — re-tint via CSS filters if needed.

Outputs go to web/public/images/vrf/.
"""

from __future__ import annotations

import os
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "images" / "vrf"
OUT.mkdir(parents=True, exist_ok=True)

# ----------------------------------------------------------------------------
# Colour palette (Pico-8-ish)
# ----------------------------------------------------------------------------
P = {
    ".": None,             # transparent
    "F": "#f2f2f2",        # mouse fur (off-white, totoro-ish)
    "f": "#d0d0d0",        # belly / shadow (light grey on white)
    "E": "#f4b6c2",        # ear / nose / paw pink
    "e": "#e07595",        # ear interior darker pink
    "K": "#1a1a1a",        # eye / outline black
    "T": "#cfcfcf",        # tail (light grey, slightly darker than body)
    "W": "#5fb4ff",        # water / reward
    "w": "#b9e0ff",        # water highlight
    "G": "#3a8a4a",        # patch ground green
    "g": "#2d6e3a",        # patch ground shadow
    "D": "#1a1a24",        # void dark
    "d": "#2a2a36",        # void mid
    "S": "#ffe27a",        # spark / lick burst
    "s": "#ffb74a",        # spark mid
    "O": "#c97aff",        # generic odor (purple)
    "o": "#7a3aa6",        # odor dark
    "L": "#ffd9e6",        # lick tongue
}


def grid_to_svg(grid: list[str], width: int, height: int, palette=P) -> str:
    """Render a string grid where each character is a palette key."""
    rects = []
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            color = palette.get(ch)
            if color is None:
                continue
            rects.append(
                f'<rect x="{x}" y="{y}" width="1" height="1" fill="{color}"/>'
            )
    body = "\n  ".join(rects)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'shape-rendering="crispEdges">\n  {body}\n</svg>\n'
    )


def write(name: str, grid: list[str], w: int, h: int):
    path = OUT / name
    path.write_text(grid_to_svg(grid, w, h))
    # sanity check on row lengths
    for i, row in enumerate(grid):
        assert len(row) == w, f"{name}: row {i} has len {len(row)} (expected {w})"
    print(f"  {name:24s} {w}x{h}  {path.stat().st_size:5d} bytes")


# ============================================================================
# Mouse — SIDE-VIEW, facing right. 24w × 16h.
# Chubby totoro-ish silhouette: big round white body, small head merged into
# body on the right with two short pointed pink-lined ears, single black dot
# eye, tiny pink nose, long trailing tail to the left, two stubby pink feet.
# ============================================================================

# Outline (K) wraps everything; F body fill (white), f belly shadow,
# E pink (ears/nose/feet), e dark pink (ear interior), T tail (light grey).
#
#  0         1         2
#  012345678901234567890123

mouse_idle = [
    "...............K....K...",  # 0  ear tips
    "..............KEK..KEK..",  # 1  ear bodies
    "............KKKEeKKKEeK.",  # 2  ears widen, head crown appears
    "..........KKFFFFFFFFFFK.",  # 3  head/body top
    "........KKFFFFFFFFFFFFFK",  # 4  big upper bulge
    ".......KFFFFFFFFFFKFFEEK",  # 5  eye(K) col 18, pink nose
    "..TTKKKFFFffffffFFFFFFEK",  # 6  tail joins, belly + nose tip
    ".TT.TKFFffffffffffFFFFFK",  # 7
    "TT...KFFfffffffffffFFFFK",  # 8
    ".TTTTKFFfffffffffffFFFFK",  # 9
    "....KFFFffffffffffFFFFFK",  # 10 body widest
    "....KFFFFFFFFFFFFFFFFFFK",  # 11 body bottom curve
    ".....KKKKKKKKKKKKKKKKKK.",  # 12 underside
    "......KEEK.....KEEK.....",  # 13 feet
    "......KEEK.....KEEK.....",  # 14
    ".......KK.......KK......",  # 15 toe tips
]

# Frame A: front foot forward, back foot trailing.
mouse_run_a = [
    "...............K....K...",
    "..............KEK..KEK..",
    "............KKKEeKKKEeK.",
    "..........KKFFFFFFFFFFK.",
    "........KKFFFFFFFFFFFFFK",
    ".......KFFFFFFFFFFKFFEEK",
    "..TTKKKFFFffffffFFFFFFEK",
    "TTT.TKFFffffffffffFFFFFK",
    ".TT..KFFfffffffffffFFFFK",
    "..TTTKFFfffffffffffFFFFK",
    "....KFFFffffffffffFFFFFK",
    "....KFFFFFFFFFFFFFFFFFFK",
    ".....KKKKKKKKKKKKKKKKKK.",
    ".....KEEK.......KEEKKK..",  # back foot back, front foot under-front
    ".....KEEK........KEEK...",
    "......KK..........KK....",
]

# Frame B: feet swapped (back foot under-back, front foot stretched forward).
mouse_run_b = [
    "...............K....K...",
    "..............KEK..KEK..",
    "............KKKEeKKKEeK.",
    "..........KKFFFFFFFFFFK.",
    "........KKFFFFFFFFFFFFFK",
    ".......KFFFFFFFFFFKFFEEK",
    "..TTKKKFFFffffffFFFFFFEK",
    ".TT.TKFFffffffffffFFFFFK",
    "TTT..KFFfffffffffffFFFFK",
    ".TTTTKFFfffffffffffFFFFK",
    "....KFFFffffffffffFFFFFK",
    "....KFFFFFFFFFFFFFFFFFFK",
    ".....KKKKKKKKKKKKKKKKKK.",
    "......KKKEEK.....KEEK...",
    "........KEEK......KEEK..",
    ".........KK........KK...",
]

# Lick pose: idle + tiny pink tongue (L) peeking out by the nose.
mouse_lick = [
    "...............K....K...",
    "..............KEK..KEK..",
    "............KKKEeKKKEeK.",
    "..........KKFFFFFFFFFFK.",
    "........KKFFFFFFFFFFFFFK",
    ".......KFFFFFFFFFFKFFEEK",
    "..TTKKKFFFffffffFFFFFFEK",
    ".TT.TKFFffffffffffFFFFLL",  # tongue (L) flicking out
    "TT...KFFfffffffffffFFFFK",
    ".TTTTKFFfffffffffffFFFFK",
    "....KFFFffffffffffFFFFFK",
    "....KFFFFFFFFFFFFFFFFFFK",
    ".....KKKKKKKKKKKKKKKKKK.",
    "......KEEK.....KEEK.....",
    "......KEEK.....KEEK.....",
    ".......KK.......KK......",
]

# ============================================================================
# Reward drop (water) — 8x10
# ============================================================================
reward_drop = [
    "...WW...",
    "..WWWW..",
    "..WWWW..",
    ".WWWWWW.",
    ".WWwWWW.",
    "WWWWWWWW",
    "WWWwWWWW",
    "WWWWWWWW",
    ".WWWWWW.",
    "..WWWW..",
]

# ============================================================================
# Lick burst — sparkle around mouth at choice moment, 12x12
# ============================================================================
lick_burst = [
    ".....SS.....",
    "...S.SS.S...",
    "..S..ss..S..",
    ".....ss.....",
    ".S.ss..ss.S.",
    "S.s......s.S",
    "S.s......s.S",
    ".S.ss..ss.S.",
    ".....ss.....",
    "..S..ss..S..",
    "...S.SS.S...",
    ".....SS.....",
]

# ============================================================================
# Odor swirl — radial dots around centre, 16x16
# Three variants share the same shape but use different fill keys.
# ============================================================================

def odor_swirl(letter: str) -> list[str]:
    base = [
        "................",
        ".....x....x.....",
        "...x........x...",
        "..x..........x..",
        ".x............x.",
        "....xx....xx....",
        "...x.xxxxxx.x...",
        "..x.xxxxxxxx.x..",
        "..x.xxxxxxxx.x..",
        "...x.xxxxxx.x...",
        "....xx....xx....",
        ".x............x.",
        "..x..........x..",
        "...x........x...",
        ".....x....x.....",
        "................",
    ]
    return [row.replace("x", letter) for row in base]


# ============================================================================
# Patch / void background tiles — 16x16, tileable
# ============================================================================
patch_tile = [
    "GgGGGGGGGgGGGGGG",
    "GGGGGgGGGGGGGGgG",
    "GGgGGGGGGGgGGGGG",
    "GGGGGGGgGGGGGgGG",
    "gGGGGGGGGGGGGGGG",
    "GGGgGGGGGgGGGGGG",
    "GGGGGGgGGGGGgGGG",
    "GgGGGGGGGGGGGGgG",
    "GGGGGGGgGGGGGGGG",
    "GGgGGGGGGGGgGGGG",
    "GGGGGGGGGgGGGGGG",
    "GgGGGgGGGGGGGgGG",
    "GGGGGGGGGGgGGGGG",
    "GGGGGgGGGGGGGGGG",
    "gGGGGGGGgGGGGGgG",
    "GGGGGGGGGGGGGGGG",
]

void_tile = [
    "DdDDDDDDDdDDDDDD",
    "DDDDDdDDDDDDDDdD",
    "DDdDDDDDDDdDDDDD",
    "DDDDDDDdDDDDDdDD",
    "dDDDDDDDDDDDDDDD",
    "DDDdDDDDDdDDDDDD",
    "DDDDDDdDDDDDdDDD",
    "DdDDDDDDDDDDDDdD",
    "DDDDDDDdDDDDDDDD",
    "DDdDDDDDDDDdDDDD",
    "DDDDDDDDDdDDDDDD",
    "DdDDDdDDDDDDDdDD",
    "DDDDDDDDDDdDDDDD",
    "DDDDDdDDDDDDDDDD",
    "dDDDDDDDdDDDDDdD",
    "DDDDDDDDDDDDDDDD",
]


# ============================================================================
# Write everything
# ============================================================================
if __name__ == "__main__":
    print(f"Writing sprites to {OUT}")
    write("mouse_run_a.svg",  mouse_run_a, 24, 16)
    write("mouse_run_b.svg",  mouse_run_b, 24, 16)
    write("mouse_idle.svg",   mouse_idle,  24, 16)
    write("mouse_lick.svg",   mouse_lick,  24, 16)
    write("reward_drop.svg",  reward_drop,  8, 10)
    write("lick_burst.svg",   lick_burst,  12, 12)
    print("Done.")
