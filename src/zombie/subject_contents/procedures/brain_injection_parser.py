"""
Brain injection procedures parser - extracts injection coordinate and material data.

This module provides functions to extract and process brain injection data
from surgical procedures, including coordinates, viral materials, volumes, and dynamics.
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


def extract_injection_coordinates(injection_proc: dict) -> tuple:
    """
    Extract coordinates from a brain injection procedure.

    Args:
        injection_proc: Brain injection procedure dictionary

    Returns:
        Tuple of (ap, ml, dv) coordinates in mm, or (0, 0, 0) if not found
    """
    coordinates = injection_proc.get("coordinates", [])
    if not coordinates or len(coordinates) == 0:
        return 0, 0, 0

    # Get first coordinate set
    coord_set = coordinates[0]
    if not coord_set or len(coord_set) == 0:
        return 0, 0, 0

    # Get translation from first transform
    translation = coord_set[0]
    if not translation or translation.get("object_type") != "Translation":
        return 0, 0, 0

    trans_vals = translation.get("translation", [])
    if len(trans_vals) >= 3:
        ap = safe_float(trans_vals[0])
        ml = safe_float(trans_vals[1])
        dv = safe_float(trans_vals[2])
        return ap, ml, dv

    return 0, 0, 0


def extract_injection_materials(injection_proc: dict) -> list[dict]:
    """
    Extract viral material information from injection procedure.

    Args:
        injection_proc: Brain injection procedure dictionary

    Returns:
        List of material dictionaries with name, titer, lot info
    """
    materials = []
    injection_materials = injection_proc.get("injection_materials", [])

    for mat in injection_materials:
        if not mat or mat.get("object_type") != "Viral material":
            continue

        tars = mat.get("tars_identifiers", {}) or {}
        material_info = {
            "name": mat.get("name", "Unknown"),
            "titer": mat.get("titer", "Unknown"),
            "titer_unit": mat.get("titer_unit", ""),
            "tars_id": tars.get("virus_tars_id", ""),
            "lot_number": tars.get("prep_lot_number", ""),
        }
        materials.append(material_info)

    return materials


def extract_injection_dynamics(injection_proc: dict) -> dict:
    """
    Extract injection dynamics (volume, duration, profile).

    Args:
        injection_proc: Brain injection procedure dictionary

    Returns:
        Dictionary with dynamics info or None if not found
    """
    dynamics = injection_proc.get("dynamics", [])
    if not dynamics or len(dynamics) == 0:
        return None

    dyn = dynamics[0]
    if not dyn:
        return None

    return {
        "profile": dyn.get("profile", "Unknown"),
        "volume": safe_float(dyn.get("volume", 0)),
        "volume_unit": dyn.get("volume_unit", "nL"),
        "duration": safe_float(dyn.get("duration", 0)) if dyn.get("duration") else None,
        "duration_unit": dyn.get("duration_unit", "s"),
    }


def get_injection_index(injection_data: dict) -> int:
    """
    Extract index number from injection name for sorting.

    Args:
        injection_data: Injection metadata dictionary

    Returns:
        Integer index or 999 if not found
    """
    name = injection_data.get("name", "")
    if "_" in name:
        try:
            return int(name.split("_")[-1])
        except (ValueError, IndexError):
            pass
    return 999


def extract_injections_from_surgery(surgery_data: dict) -> list[dict]:
    """
    Extract all brain injection data from a surgery procedure.

    Searches through surgery sub-procedures for brain injection procedures
    and extracts their coordinates, materials, and dynamics.

    Args:
        surgery_data: Surgery procedure dictionary

    Returns:
        List of injection metadata dictionaries
    """
    injections = []

    for idx, proc in enumerate(surgery_data.get("procedures", [])):
        if not proc:
            continue

        # Look for Brain injection procedures
        if proc.get("object_type") != "Brain injection":
            continue

        # Extract coordinates
        ap, ml, dv = extract_injection_coordinates(proc)

        # Extract materials
        materials = extract_injection_materials(proc)
        material_names = [m["name"] for m in materials]

        # Extract dynamics
        dynamics = extract_injection_dynamics(proc)

        # Get relative position
        positions = proc.get("relative_position", [])
        position_str = ", ".join(positions) if positions else "Unknown"

        # Get coordinate system
        coord_system = proc.get("coordinate_system_name", "Unknown")

        injection_data = {
            "name": f"Injection_{idx}",
            "ap": ap,
            "ml": ml,
            "dv": dv,
            "unit": "millimeter",
            "reference": coord_system,
            "position": position_str,
            "materials": materials,
            "material_names": material_names,
            "dynamics": dynamics,
            "protocol_id": proc.get("protocol_id", "Not specified"),
        }

        injections.append(injection_data)

    return injections


def has_brain_injections(surgery_data: dict) -> bool:
    """
    Check if a surgery has any brain injection procedures.

    Args:
        surgery_data: Surgery procedure dictionary

    Returns:
        True if surgery contains brain injection procedures
    """
    for proc in surgery_data.get("procedures", []):
        if proc and proc.get("object_type") == "Brain injection":
            return True
    return False
