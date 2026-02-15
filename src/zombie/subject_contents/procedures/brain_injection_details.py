"""
Brain injection details pane - visualizes brain injection locations and materials.

This module renders an interactive view showing brain injection coordinates
using hvplot. The visualization includes injection coordinates, viral materials,
volumes, and detailed metadata.
"""

import pandas as pd
import panel as pn
import hvplot.pandas
import holoviews as hv

from zombie.subject_contents.procedures.brain_injection_parser import (
    extract_injections_from_surgery,
    get_injection_index,
)
from zombie.subject_contents.procedures.brain_visualization import (
    create_brain_scatter_plot,
)


def create_injection_table(injections: list[dict]) -> pd.DataFrame:
    """
    Create a DataFrame from injection data for display.

    Args:
        injections: List of injection metadata dictionaries

    Returns:
        DataFrame with injection information
    """
    rows = []
    for injection in injections:
        ap = injection.get("ap", 0)
        ml = injection.get("ml", 0)
        dv = injection.get("dv", 0)

        # Get material names
        materials = ", ".join(injection.get("material_names", []))
        if not materials:
            materials = "Not specified"

        # Get volume from dynamics
        dynamics = injection.get("dynamics")
        volume_str = "N/A"
        if dynamics:
            volume = dynamics.get("volume", 0)
            volume_unit = dynamics.get("volume_unit", "nL")
            volume_str = f"{volume:.1f} {volume_unit}"

        row = {
            "Injection": injection.get("name", "Unknown"),
            "AP (mm)": f"{ap:.2f}",
            "ML (mm)": f"{ml:.2f}",
            "DV (mm)": f"{dv:.2f}",
            "Material": materials,
            "Volume": volume_str,
            "Position": injection.get("position", "Unknown"),
        }
        rows.append(row)

    return pd.DataFrame(rows)


def create_injection_scatter_plot(injections: list[dict]) -> object:
    """
    Create a scatter plot showing injection locations in AP/ML space.

    Args:
        injections: List of injection metadata dictionaries

    Returns:
        HoloViews composite with properly scaled background image
    """
    # Extract points and labels
    points = []
    labels = []

    for injection in injections:
        ml = injection.get("ml", 0)
        ap = injection.get("ap", 0)
        name = injection.get("name", "Unknown")

        points.append((ml, ap))
        labels.append(name)

    # Create plot using shared visualization function
    plot = create_brain_scatter_plot(
        points=points,
        labels=labels,
        title="Brain Injection Locations (Top View)",
    )

    return plot


def create_brain_injection_details_pane(surgery_data: dict, subject_id: str = "Unknown"):
    """
    Create a details pane showing brain injection visualization.

    Main entry point for creating the brain injection details visualization.
    Extracts injection data from surgery and renders the visualization.

    Args:
        surgery_data: Surgery procedure dictionary
        subject_id: Subject identifier

    Returns:
        Panel pane containing the visualization or error message
    """
    print(f"[create_brain_injection_details_pane] Called with subject_id={subject_id}")

    # Extract injection data
    injections = extract_injections_from_surgery(surgery_data)
    print(f"[create_brain_injection_details_pane] Extracted {len(injections)} injections")

    if not injections:
        return pn.pane.Markdown(
            "**No brain injection data found in this surgery.**",
            styles={
                "background": "#fff8e1",
                "border-left": "4px solid #ffc107",
                "padding": "10px",
                "border-radius": "5px",
            },
        )

    # Sort injections by index
    injections_sorted = sorted(injections, key=get_injection_index)

    try:
        print(f"[create_brain_injection_details_pane] Creating visualization...")

        # Create coordinate table
        injection_df = create_injection_table(injections_sorted)
        table_pane = pn.pane.DataFrame(
            injection_df,
            sizing_mode="stretch_width",
            index=False,
            max_rows=20,
        )

        # Create scatter plot
        plot = create_injection_scatter_plot(injections_sorted)
        plot_pane = pn.pane.HoloViews(plot)

        # Create detailed material info
        material_sections = []
        for idx, injection in enumerate(injections_sorted):
            materials = injection.get("materials", [])
            if materials:
                material_sections.append(f"\n**{injection['name']} Materials:**")
                for mat in materials:
                    material_sections.append(f"- {mat['name']}")
                    if mat.get("titer") and mat["titer"] != "Unknown":
                        material_sections.append(f"  - Titer: {mat['titer']} {mat.get('titer_unit', '')}")
                    if mat.get("tars_id"):
                        material_sections.append(f"  - TARS ID: {mat['tars_id']}")
                    if mat.get("lot_number"):
                        material_sections.append(f"  - Lot: {mat['lot_number']}")

        # Create info markdown
        info_lines = [f"**Brain Injection Summary** (Subject: {subject_id})\n"]
        info_lines.append(f"- Total injections: {len(injections_sorted)}")

        # Get unique materials
        all_materials = []
        for inj in injections_sorted:
            all_materials.extend(inj.get("material_names", []))
        unique_materials = list(set(all_materials))
        if unique_materials:
            info_lines.append(f"- Materials: {', '.join(unique_materials)}")

        info_md = pn.pane.Markdown("\n".join(info_lines))

        # Create material details markdown if any
        material_md = None
        if material_sections:
            material_md = pn.pane.Markdown("\n".join(material_sections))

        # Combine into column
        viz_column = pn.Column(
            info_md,
            pn.pane.Markdown("### Injection Coordinates"),
            table_pane,
            pn.pane.Markdown("### Spatial Layout"),
            plot_pane,
        )

        if material_md:
            viz_column.append(pn.pane.Markdown("### Material Details"))
            viz_column.append(material_md)

        print(f"[create_brain_injection_details_pane] Visualization created successfully")
        return viz_column

    except Exception as e:
        print(f"[create_brain_injection_details_pane] Error creating visualization: {e}")
        import traceback

        traceback.print_exc()
        return pn.pane.Markdown(
            f"**Error creating brain injection visualization:** {str(e)}",
            styles={
                "background": "#fff5f5",
                "border-left": "4px solid #f44336",
                "padding": "10px",
                "border-radius": "5px",
            },
        )
