"""
Fiber implant details pane - visualizes fiber photometry probe locations.

This module renders an interactive view showing fiber implant coordinates
using hvplot. The visualization includes fiber coordinates, targets, and 
detailed metadata.
"""

import pandas as pd
import panel as pn
import hvplot.pandas
import holoviews as hv

from zombie.subject_contents.procedures.fiber_implant_parser import (
    extract_fibers_from_surgery,
    get_fiber_index,
    safe_float,
)
from zombie.subject_contents.procedures.brain_visualization import (
    create_brain_scatter_plot,
)


def create_fiber_table(fibers: list[dict]) -> pd.DataFrame:
    """
    Create a DataFrame from fiber data for display.
    
    Args:
        fibers: List of fiber metadata dictionaries
        
    Returns:
        DataFrame with fiber information
    """
    rows = []
    for fiber in fibers:
        ap = safe_float(fiber.get("ap", 0))
        ml = safe_float(fiber.get("ml", 0))
        dv = fiber.get("dv")
        angle = safe_float(fiber.get("angle", 0))
        
        row = {
            "Fiber": fiber.get("name", "Unknown"),
            "AP (mm)": f"{ap:.2f}",
            "ML (mm)": f"{ml:.2f}",
            "DV (mm)": f"{dv:.2f}" if dv is not None else "N/A",
            "Angle (°)": f"{angle:.1f}" if abs(angle) > 0.1 else "0",
            "Target": fiber.get("targeted_structure", "Not specified"),
        }
        rows.append(row)
    
    return pd.DataFrame(rows)


def create_fiber_scatter_plot(fibers: list[dict]) -> object:
    """
    Create a scatter plot showing fiber locations in AP/ML space.
    
    Args:
        fibers: List of fiber metadata dictionaries
        
    Returns:
        HoloViews composite with properly scaled background image
    """
    # Extract points and labels
    points = []
    labels = []
    
    for fiber in fibers:
        ml = safe_float(fiber.get("ml", 0))
        ap = safe_float(fiber.get("ap", 0))
        name = fiber.get("name", "Unknown")
        
        points.append((ml, ap))
        labels.append(name)
    
    # Create plot using shared visualization function
    plot = create_brain_scatter_plot(
        points=points,
        labels=labels,
        title="Fiber Implant Locations (Top View)",
    )
    
    return plot


def create_fiber_implant_details_pane(surgery_data: dict, subject_id: str = "Unknown"):
    """
    Create a details pane showing fiber implant visualization.
    
    Main entry point for creating the fiber implant details visualization.
    Extracts fiber data from surgery and renders the visualization using hvplot.
    
    Args:
        surgery_data: Surgery procedure dictionary
        subject_id: Subject identifier
        
    Returns:
        Panel pane containing the visualization or error message
    """
    print(f"[create_fiber_implant_details_pane] Called with subject_id={subject_id}")
    
    # Extract fiber data
    fibers = extract_fibers_from_surgery(surgery_data)
    print(f"[create_fiber_implant_details_pane] Extracted {len(fibers)} fibers")
    
    if not fibers:
        return pn.pane.Markdown(
            "**No fiber implant data found in this surgery.**",
            styles={
                "background": "#fff8e1",
                "border-left": "4px solid #ffc107",
                "padding": "10px",
                "border-radius": "5px",
            },
        )
    
    # Sort fibers by index
    fibers_sorted = sorted(fibers, key=get_fiber_index)
    
    try:
        print(f"[create_fiber_implant_details_pane] Creating visualization...")
        
        # Create coordinate table
        fiber_df = create_fiber_table(fibers_sorted)
        table_pane = pn.pane.DataFrame(
            fiber_df,
            sizing_mode="stretch_width",
            index=False,
            max_rows=20,
        )
        
        # Create scatter plot
        plot = create_fiber_scatter_plot(fibers_sorted)
        plot_pane = pn.pane.HoloViews(
            plot,
        )
        
        # Create detailed info
        info_lines = [f"**Fiber Implant Summary** (Subject: {subject_id})\n"]
        info_lines.append(f"- Total fibers: {len(fibers_sorted)}")
        
        # Get unique targets
        targets = list(set(f.get("targeted_structure", "Unknown") for f in fibers_sorted))
        if targets:
            info_lines.append(f"- Target structures: {', '.join(targets)}")
        
        info_md = pn.pane.Markdown("\n".join(info_lines))
        
        # Combine into column - don't use sizing_mode to preserve plot dimensions
        viz_column = pn.Column(
            info_md,
            pn.pane.Markdown("### Fiber Coordinates"),
            table_pane,
            pn.pane.Markdown("### Spatial Layout"),
            plot_pane,
        )
        
        print(f"[create_fiber_implant_details_pane] Visualization created successfully")
        print(f"[create_fiber_implant_details_pane] Returning viz_column with {len(viz_column)} items")
        print(f"[create_fiber_implant_details_pane] viz_column type: {type(viz_column)}")
        return viz_column
        
    except Exception as e:
        print(f"[create_fiber_implant_details_pane] Error creating visualization: {e}")
        import traceback
        traceback.print_exc()
        return pn.pane.Markdown(
            f"**Error creating fiber implant visualization:** {str(e)}",
            styles={
                "background": "#fff5f5",
                "border-left": "4px solid #f44336",
                "padding": "10px",
                "border-radius": "5px",
            },
        )
