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
    "F": "#f4d6c4",        # mouse fur (warm light)
    "f": "#d9a98a",        # mouse fur shadow
    "E": "#ff9bb3",        # ear / nose pink
    "K": "#1a1a1a",        # eye / outline black
    "T": "#b87a5a",        # tail
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
# Mouse — top-down, head pointed up (north). 16x16.
# K = black outline so the silhouette reads at any zoom.
# Forepaws (rows 11-12) and hindlegs (rows 13-14) alternate between frames.
# ============================================================================

mouse_run_a = [
    # 0123456789012345
    "................",  # 0
    "....KEK..KEK....",  # 1 ear outlines + pink
    "...KEEK..KEEK...",  # 2
    "...KEFKKKKFEK...",  # 3
    "....KFFFFFFK....",  # 4
    "....FKFFFFKF....",  # 5 eyes (K)
    "...KFFFEEFFFK...",  # 6 pink nose
    "...KFFFFFFFFK...",  # 7
    "..KFFffffFFFFK..",  # 8 shoulders + shading
    "..KFffffffffFK..",  # 9
    "..KFffffffffFK..",  # 10
    ".KFK..FFFF..KFK.",  # 11 forepaws extended
    "..K....FF....K..",  # 12
    "...KF.FFFF.FK...",  # 13 hindlegs tucked
    "....KKKTTKKK....",  # 14 rump + tail base
    "........TT......",  # 15 tail
]

mouse_run_b = [
    "................",
    "....KEK..KEK....",
    "...KEEK..KEEK...",
    "...KEFKKKKFEK...",
    "....KFFFFFFK....",
    "....FKFFFFKF....",
    "...KFFFEEFFFK...",
    "...KFFFFFFFFK...",
    "..KFFffffFFFFK..",
    "..KFffffffffFK..",
    "..KFffffffffFK..",
    "...KFFFFFFFFK...",  # forepaws tucked
    "...KFFFFFFFFK...",
    ".KFK.FFFFFF.KFK.",  # hindlegs extended
    "..K..KKTTKK..K..",
    ".......TT.......",
]

mouse_idle = [
    "................",
    "....KEK..KEK....",
    "...KEEK..KEEK...",
    "...KEFKKKKFEK...",
    "....KFFFFFFK....",
    "....FKFFFFKF....",
    "...KFFFEEFFFK...",
    "...KFFFFFFFFK...",
    "..KFFffffFFFFK..",
    "..KFffffffffFK..",
    "..KFffffffffFK..",
    "...KFFFFFFFFK...",
    "...KFFFFFFFFK...",
    "....KFFFFFFK....",
    "....KKKTTKKK....",
    "........TT......",
]

# Lick pose: head dipped, big pink tongue sticking up from nose
mouse_lick = [
    "........L.......",  # 0 tongue tip
    "....KEK.LL.KEK..",
    "...KEEK.LL.KEEK.",
    "...KEFKLLLLFEK..",
    "....KFFLLFFK....",
    "....FKFLLFKF....",  # eyes squinted
    "...KFFFLLFFFK...",
    "...KFFFFFFFFK...",
    "..KFFffffFFFFK..",
    "..KFffffffffFK..",
    "..KFffffffffFK..",
    "...KFFFFFFFFK...",
    "...KFFFFFFFFK...",
    "....KFFFFFFK....",
    "....KKKTTKKK....",
    "........TT......",
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
    write("mouse_run_a.svg",  mouse_run_a, 16, 16)
    write("mouse_run_b.svg",  mouse_run_b, 16, 16)
    write("mouse_idle.svg",   mouse_idle,  16, 16)
    write("mouse_lick.svg",   mouse_lick,  16, 16)
    write("reward_drop.svg",  reward_drop,  8, 10)
    write("lick_burst.svg",   lick_burst,  12, 12)
    write("odor_swirl_O.svg", odor_swirl("O"), 16, 16)
    # Two tinted variants — odor_60 (warm) and odor_90 (cool) — using
    # alternate palette keys substituted at write-time:
    alt = dict(P)
    alt["O"] = "#ffb33a"  # odor_60 amber
    Path(OUT / "odor_swirl_60.svg").write_text(grid_to_svg(odor_swirl("O"), 16, 16, alt))
    alt["O"] = "#3aaaff"  # odor_90 azure
    Path(OUT / "odor_swirl_90.svg").write_text(grid_to_svg(odor_swirl("O"), 16, 16, alt))
    alt["O"] = "#888888"  # odor_0 grey (control)
    Path(OUT / "odor_swirl_0.svg").write_text(grid_to_svg(odor_swirl("O"), 16, 16, alt))
    print("  odor_swirl_{60,90,0}.svg")
    write("patch_tile.svg",   patch_tile,  16, 16)
    write("void_tile.svg",    void_tile,   16, 16)
    print("Done.")
