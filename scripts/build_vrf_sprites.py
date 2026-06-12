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
    "F": "#9a9a9a",        # mouse fur (grey)
    "f": "#bcbcbc",        # mouse belly (lighter grey)
    "E": "#f4b6c2",        # ear / nose / paw pink
    "e": "#e07595",        # ear interior darker pink
    "K": "#1a1a1a",        # eye / outline black
    "T": "#7a7a7a",        # tail (slightly darker grey)
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
# Classic chunky pixel mouse: grey fur, round head with two ears on top,
# pointy snout with pink nose, single black eye, plump body, curly tail
# trailing left, two short pink feet underneath.
# ============================================================================

# Outline (K) wraps everything; F fur, f belly highlight, E pink (ears/nose/feet)
# e dark pink (ear interior), T tail.
#
#  0         1         2
#  012345678901234567890123

mouse_idle = [
    "........KK.....KK.......",  # 0  ear tops
    ".......KEeK...KEeK......",  # 1
    ".......KEeKKKKKEeK......",  # 2
    ".......KFFFFFFFFFFK.....",  # 3  head top
    "......KFFFFFFFFFFFFK....",  # 4
    "KKKK..KFFFFFKFFFFFFKKK..",  # 5  eye, snout start
    "KTTKKKFFFFFFFFFFFFFFFEK.",  # 6  tail + snout + nose (E)
    "K..TKFFFFFFFFFFFFFFFFEK.",  # 7
    "KTTKFFFFFFFFFFFFFFFFFFK.",  # 8
    "KK.KFFfffffffffffffFFFK.",  # 9  belly highlight
    ".KKKFFfffffffffffffFFFK.",  # 10
    "...KFFfffffffffffffFFK..",  # 11
    "...KFFKKKFFFFKKKFFFFFK..",  # 12  underside / leg sockets
    "....KEEKKKKKKKEEKKKKK...",  # 13  feet
    "....KEEK......KEEK......",  # 14
    ".....KK........KK.......",  # 15
]

# Frame A: front feet planted forward, back feet tucked back.
mouse_run_a = [
    "........KK.....KK.......",
    ".......KEeK...KEeK......",
    ".......KEeKKKKKEeK......",
    ".......KFFFFFFFFFFK.....",
    "......KFFFFFFFFFFFFK....",
    "KKKK..KFFFFFKFFFFFFKKK..",
    "KTTKKKFFFFFFFFFFFFFFFEK.",
    "K..TKFFFFFFFFFFFFFFFFEK.",
    "KTTKFFFFFFFFFFFFFFFFFFK.",
    "KK.KFFfffffffffffffFFFK.",
    ".KKKFFfffffffffffffFFFK.",
    "...KFFfffffffffffffFFK..",
    "...KFFFFKFFFFFFFFKFFFK..",  # back leg slightly back
    "....KKKEEKKKKKKKEEKKK...",
    "....KEEK........KEEK....",  # back foot trailing, front foot forward
    "....KKK..........KKK....",
]

# Frame B: feet swapped (back foot forward, front foot trailing).
mouse_run_b = [
    "........KK.....KK.......",
    ".......KEeK...KEeK......",
    ".......KEeKKKKKEeK......",
    ".......KFFFFFFFFFFK.....",
    "......KFFFFFFFFFFFFK....",
    "KKKK..KFFFFFKFFFFFFKKK..",
    "KTTKKKFFFFFFFFFFFFFFFEK.",
    "K..TKFFFFFFFFFFFFFFFFEK.",
    "KTTKFFFFFFFFFFFFFFFFFFK.",
    "KK.KFFfffffffffffffFFFK.",
    ".KKKFFfffffffffffffFFFK.",
    "...KFFfffffffffffffFFK..",
    "...KFFFFKFFFFFFFFKFFFK..",
    "....KKKKEEKKKKKKEEKKK...",
    "......KEEK......KEEK....",  # opposite phase
    "......KKK........KKK....",
]

# Lick pose: idle + tiny pink tongue at the nose.
mouse_lick = [
    "........KK.....KK.......",
    ".......KEeK...KEeK......",
    ".......KEeKKKKKEeK......",
    ".......KFFFFFFFFFFK.....",
    "......KFFFFFFFFFFFFK....",
    "KKKK..KFFFFFKFFFFFFKKK..",
    "KTTKKKFFFFFFFFFFFFFFFEKE",  # tongue (E) sticking out right
    "K..TKFFFFFFFFFFFFFFFFEKE",
    "KTTKFFFFFFFFFFFFFFFFFFK.",
    "KK.KFFfffffffffffffFFFK.",
    ".KKKFFfffffffffffffFFFK.",
    "...KFFfffffffffffffFFK..",
    "...KFFKKKFFFFKKKFFFFFK..",
    "....KEEKKKKKKKEEKKKKK...",
    "....KEEK......KEEK......",
    ".....KK........KK.......",
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
