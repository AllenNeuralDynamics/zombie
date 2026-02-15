"""
Fiber implant procedures parser - extracts fiber coordinate data from device configurations.

This module provides functions to extract and process fiber photometry implant data
from surgical procedures. The data includes coordinates (AP, ML, DV), angles, and
targeted brain structures.
"""


def safe_float(value, default=0.0):
    """
    Safely convert value to float, handling None and invalid values.

    Args:
        value: Value to convert to float
        default: Default value if conversion fails

    Returns:
        Float value or default
    """
    if value is None:
        return default
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def extract_fiber_metadata(device_config: dict) -> dict:
    """
    Extract fiber coordinates and metadata from device config.

    Parses the transform array in the device configuration to extract:
    - Translation coordinates (AP, ML, DV)
    - Rotation angle
    - Targeted brain structure
    - Device name

    Args:
        device_config: Device configuration dictionary with transform data

    Returns:
        Dictionary with fiber metadata including coordinates, angle, target structure
    """
    ml = ap = angle = 0
    dv = None  # None means no depth available

    # Extract coordinates from transform array
    for transform_obj in device_config.get("transform", []):
        obj_type = transform_obj.get("object_type", "")

        if obj_type == "Translation":
            translation = transform_obj.get("translation", [])
            if len(translation) >= 3:
                ap = safe_float(translation[0])
                ml = safe_float(translation[1])
                dv = safe_float(translation[2])

        elif obj_type == "Rotation":
            rotation = transform_obj.get("rotation", [])
            if len(rotation) >= 3:
                angle = safe_float(rotation[0])

    # Get targeted structure
    target = (device_config.get("primary_targeted_structure") or {}).get(
        "name", "Not specified in surgical request form"
    )

    return {
        "name": device_config.get("device_name", "Unknown"),
        "ap": ap,
        "ml": ml,
        "dv": dv,
        "angle": angle,
        "unit": "millimeter",
        "reference": (device_config.get("coordinate_system") or {}).get("origin", "Bregma"),
        "targeted_structure": target,
    }


def extract_fibers_from_surgery(surgery_data: dict) -> list[dict]:
    """
    Extract all fiber implant data from a surgery procedure.

    Searches through surgery sub-procedures for probe implant procedures
    and extracts their device configurations.

    Args:
        surgery_data: Surgery procedure dictionary

    Returns:
        List of fiber metadata dictionaries
    """
    fibers = []

    for proc in surgery_data.get("procedures", []):
        if not proc:
            continue

        # Look for Probe implant procedures (fiber probes)
        if proc.get("object_type") == "Probe implant":
            device_config = proc.get("device_config")
            if device_config:
                fiber_metadata = extract_fiber_metadata(device_config)
                fibers.append(fiber_metadata)

    return fibers


def has_fiber_implants(surgery_data: dict) -> bool:
    """
    Check if a surgery contains fiber implant procedures.

    Args:
        surgery_data: Surgery procedure dictionary

    Returns:
        True if surgery contains fiber implants (probe implants), False otherwise
    """
    for proc in surgery_data.get("procedures", []):
        if proc and proc.get("object_type") == "Probe implant":
            return True
    return False


def get_fiber_index(fiber: dict) -> int:
    """
    Extract numeric index from fiber name for sorting.

    Args:
        fiber: Fiber metadata dictionary

    Returns:
        Numeric index (defaults to 999 if not found)
    """
    name = fiber.get("name", "Unknown")
    try:
        # Extract number from names like "Fiber_0", "Fiber_1", etc.
        return int(name.split("_")[-1])
    except (ValueError, IndexError):
        return 999  # Put unknown fibers at end
