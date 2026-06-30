"""
Compute the CCF centroid of each brain structure on the LEFT hemisphere
using the BrainGlobe Allen Mouse 100µm v1.2 annotation volume.

Volume shape: (132, 80, 114) — orientation "asr"
  axis 0: anterior→posterior  (AP), resolution 100µm
  axis 1: superior→inferior   (DV), resolution 100µm
  axis 2: right→left          (LR), resolution 100µm, index 0 = right side

Left hemisphere: axis-2 indices >= 57  (midline at 5700µm = index 57)

The annotation TIFF only contains leaf-level structure IDs.  For every parent
structure we accumulate the voxels of ALL its annotated descendants before
computing the centroid, so every entry in structures.json gets a valid center.

Output: web/src/subject/allen_mouse_100um_v1.2/ccf_structure_centers.json
  { "<structure_id>": [x, y, z], ... }
  where x/y/z are three.js coordinates in mm (origin = Bregma):
    x = (ccf_ML - 5700) / 1000
    y = (332 - ccf_DV) / 1000
    z = (5400 - ccf_AP) / 1000
"""

import json
import pathlib
import numpy as np
import tifffile

ATLAS_DIR = pathlib.Path.home() / ".brainglobe" / "allen_mouse_100um_v1.2"
STRUCTURES_PATH = (
    pathlib.Path(__file__).parent.parent
    / "web/src/subject/allen_mouse_100um_v1.2/structures.json"
)
OUT_PATH = (
    pathlib.Path(__file__).parent.parent
    / "web/src/subject/allen_mouse_100um_v1.2/ccf_structure_centers.json"
)

RES = 100.0          # µm per voxel
BREGMA_AP = 5400.0   # µm
BREGMA_DV = 332.0    # µm
BREGMA_ML = 5700.0   # µm
MIDLINE_IDX = 57     # axis-2 index of midline (5700µm / 100µm)


def ccf_to_threejs(ap_um, dv_um, ml_um):
    x = (ml_um - BREGMA_ML) / 1000.0
    y = (BREGMA_DV - dv_um) / 1000.0
    z = (BREGMA_AP - ap_um) / 1000.0
    return x, y, z


def main():
    # ── 1. Load annotation (left hemisphere only) ───────────────────────────
    print("Loading annotation TIFF…")
    ann = tifffile.imread(str(ATLAS_DIR / "annotation.tiff"))
    print(f"  shape={ann.shape}, dtype={ann.dtype}")
    left = ann[:, :, MIDLINE_IDX:]   # shape (132, 80, 57)

    # For each voxel record its AP/DV/LR index.
    ap_idx, dv_idx, lr_sub_idx = np.nonzero(left)         # skip background (0)
    sid_flat = left[ap_idx, dv_idx, lr_sub_idx].astype(np.int64)
    lr_idx = lr_sub_idx + MIDLINE_IDX                      # full-volume LR index

    # Per-leaf-structure accumulators: sum_ap, sum_dv, sum_ml, count
    leaf_stats: dict[int, list] = {}
    for ap, dv, lr, sid in zip(ap_idx, dv_idx, lr_idx, sid_flat):
        sid = int(sid)
        if sid not in leaf_stats:
            leaf_stats[sid] = [0.0, 0.0, 0.0, 0]
        s = leaf_stats[sid]
        s[0] += int(ap)
        s[1] += int(dv)
        s[2] += int(lr)
        s[3] += 1
    print(f"  {len(leaf_stats)} leaf structures annotated in left hemisphere")

    # ── 2. Build ancestor map from structures.json ──────────────────────────
    with open(STRUCTURES_PATH) as f:
        structs = json.load(f)

    # Map each structure id → its full id-path (list of ancestor ids, root→self)
    id_to_path: dict[int, list[int]] = {
        s["id"]: s["structure_id_path"] for s in structs
    }
    all_structure_ids = list(id_to_path.keys())

    # For each structure, accumulate stats from every leaf descendant whose
    # id-path contains this structure's id.
    # Build reverse map: ancestor_id → [leaf_ids that descend from it]
    ancestor_to_leaves: dict[int, list[int]] = {sid: [] for sid in all_structure_ids}
    for leaf_id in leaf_stats:
        path = id_to_path.get(leaf_id, [leaf_id])
        for ancestor_id in path:
            if ancestor_id in ancestor_to_leaves:
                ancestor_to_leaves[ancestor_id].append(leaf_id)

    # ── 3. Compute centroid for every structure ──────────────────────────────
    centers = {}
    for struct_id in all_structure_ids:
        leaves = ancestor_to_leaves.get(struct_id, [])
        if not leaves:
            continue
        sum_ap = sum_dv = sum_ml = 0.0
        count = 0
        for leaf_id in leaves:
            s = leaf_stats[leaf_id]
            sum_ap += s[0]; sum_dv += s[1]; sum_ml += s[2]; count += s[3]
        if count == 0:
            continue
        ap_um = sum_ap / count * RES + RES / 2
        dv_um = sum_dv / count * RES + RES / 2
        ml_um = sum_ml / count * RES + RES / 2
        x, y, z = ccf_to_threejs(ap_um, dv_um, ml_um)
        centers[str(struct_id)] = [round(x, 3), round(y, 3), round(z, 3)]

    print(f"  computed centers for {len(centers)} / {len(all_structure_ids)} structures")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(centers, f, separators=(",", ":"))
        f.write("\n")

    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"Saved to {OUT_PATH}  ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
