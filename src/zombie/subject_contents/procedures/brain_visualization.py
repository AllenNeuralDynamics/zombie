"""
Shared brain visualization utilities for creating scatter plots with skull background.

This module provides common functionality for visualizing brain procedures (fiber implants,
injections, etc.) on a mouse skull image with proper coordinate transformation.
"""

from pathlib import Path
import math
import holoviews as hv
from PIL import Image
import numpy as np
from importlib.resources import files

# Skull image configuration
BREGMA_LAMBDA_DISTANCE_MM = 4.2  # Anatomical distance between Bregma and Lambda in mm
SKULL_IMAGE_VERTICAL_OFFSET_MM = -2.5  # Negative shifts image down (posterior), positive shifts up (anterior)
BREGMA_PIXEL_COORDINATES = (412, 816)  # identified manually from image
LAMBDA_PIXEL_COORDINATES = (412, 1020)  # identified manually from image

# Standard colors for multiple items
ITEM_COLORS = [
    "#FF6B6B",  # Red
    "#4CAF50",  # Green
    "#2196F3",  # Blue
    "#FF9800",  # Orange
    "#9C27B0",  # Purple
    "#00BCD4",  # Cyan
    "#FFC107",  # Amber
    "#795548",  # Brown
]


def load_skull_image():
    """Load the mouse skull image from the package."""
    img_file = files('zombie').joinpath('images', 'mouse_skull.png')
    with img_file.open('rb') as f:
        return Image.open(f).copy()


def calculate_image_bounds():
    """
    Calculate the coordinate bounds for the skull image in mm.

    Returns:
        Tuple of (x_min, y_min, x_max, y_max, scale_factor) in mm coordinates
    """
    img = load_skull_image()
    img_width_px, img_height_px = img.size

    # Calculate pixel distance between Bregma and Lambda
    bregma_px = BREGMA_PIXEL_COORDINATES
    lambda_px = LAMBDA_PIXEL_COORDINATES
    pixel_distance = math.sqrt((lambda_px[0] - bregma_px[0]) ** 2 + (lambda_px[1] - bregma_px[1]) ** 2)

    # Calculate scale factor (mm per pixel)
    scale_factor = BREGMA_LAMBDA_DISTANCE_MM / pixel_distance

    # Calculate image dimensions in mm (schematic units)
    img_width_mm = img_width_px * scale_factor
    img_height_mm = img_height_px * scale_factor

    # Calculate Bregma position in mm relative to image top-left corner
    bregma_x_from_left = bregma_px[0] * scale_factor
    bregma_y_from_top = bregma_px[1] * scale_factor

    # Calculate image extent in schematic coordinates
    x_min = -bregma_x_from_left
    x_max = x_min + img_width_mm

    # Y-axis: flip image coordinate system and apply vertical offset
    offset = SKULL_IMAGE_VERTICAL_OFFSET_MM
    y_max = bregma_y_from_top + offset
    y_min = y_max - img_height_mm

    return x_min, y_min, x_max, y_max, scale_factor


def create_skull_background():
    """
    Create a HoloViews RGB element with the skull image as background.

    Returns:
        HoloViews RGB element with proper bounds
    """
    img = load_skull_image()
    x_min, y_min, x_max, y_max, _ = calculate_image_bounds()
    
    img_array = np.array(img)
    background = hv.RGB(img_array, bounds=(x_min, y_min, x_max, y_max)).opts(
        alpha=0.6,
    )

    return background


def create_bregma_reference():
    """
    Create HoloViews elements for the Bregma reference point and label.

    Returns:
        Tuple of (point, label) HoloViews elements
    """
    offset = SKULL_IMAGE_VERTICAL_OFFSET_MM

    bregma_point = hv.Scatter([(0, 0 + offset)]).opts(
        color="black",
        marker="x",
        size=10,
        line_width=2,
    )

    bregma_label = hv.Text(0, -0.8 + offset, "Bregma").opts(
        color="black",
        text_font_size="9pt",
        text_font_style="bold",
    )

    return bregma_point, bregma_label


def create_brain_scatter_plot(
    points,
    labels,
    colors=None,
    title="Brain Locations (Top View)",
    width=360,
    height=600,
    xlim=(-6, 6),
    ylim=(-10, 10),
):
    """
    Create a scatter plot showing locations in AP/ML space with skull background.

    Args:
        points: List of (ml, ap) tuples for scatter points
        labels: List of label strings for each point
        colors: List of colors for each point (optional, uses defaults if None)
        title: Plot title
        width: Plot width in pixels
        height: Plot height in pixels
        xlim: X-axis limits (ML)
        ylim: Y-axis limits (AP)

    Returns:
        HoloViews composite plot
    """
    if colors is None:
        colors = [ITEM_COLORS[i % len(ITEM_COLORS)] for i in range(len(points))]

    # Create background
    background = create_skull_background()
    offset = SKULL_IMAGE_VERTICAL_OFFSET_MM

    # Create scatter points and text labels
    scatter_elements = []
    text_elements = []

    for idx, ((ml, ap), label, color) in enumerate(zip(points, labels, colors)):
        # Adjust AP coordinate with offset
        ap_adjusted = ap + offset

        # Create scatter point
        point = hv.Scatter([(ml, ap_adjusted)]).opts(
            color=color,
            size=8,
            line_color="black",
            line_width=1,
        )
        scatter_elements.append(point)

        # Create text label above the point
        text = hv.Text(ml, ap_adjusted + 0.9, label).opts(
            color=color,
            text_font_size="10pt",
            text_font_style="bold",
        )
        text_elements.append(text)

    # Add Bregma reference
    bregma_point, bregma_label = create_bregma_reference()

    # Combine all elements
    overlay = background
    for elem in scatter_elements:
        overlay = overlay * elem
    for elem in text_elements:
        overlay = overlay * elem
    overlay = overlay * bregma_point * bregma_label

    # Apply final options
    final = overlay.opts(
        width=width,
        height=height,
        xlim=xlim,
        ylim=ylim,
        aspect=12 / 20,
        xlabel="Medial-Lateral (mm)",
        ylabel="Anterior-Posterior (mm)",
        title=title,
    )

    return final
