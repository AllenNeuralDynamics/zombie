"""Parsers for different types of timeline events."""

from datetime import timedelta
import pandas as pd

from zombie.subject_contents.procedures.fiber_implant_parser import has_fiber_implants


NO_END_DATE_DURATION = timedelta(days=1)  # Default duration for events without end date


def normalize_timestamp(ts):
    """Convert timestamp to timezone-aware UTC for consistent comparisons."""
    dt = pd.to_datetime(ts)
    # If timezone-naive, assume UTC
    if dt.tz is None:
        return dt.tz_localize("UTC")
    # If timezone-aware, convert to UTC
    return dt.tz_convert("UTC")


def parse_birth(subject):
    """Parse birth event from subject data."""
    if not subject:
        return None

    subject_details = subject.get("subject_details", {})
    if not subject_details:
        return None

    dob = subject_details.get("date_of_birth")
    if not dob:
        return None

    try:
        dob_date = normalize_timestamp(dob)
        # Birth is instantaneous - show as a wider line for visibility
        return {
            "start": dob_date,
            "end": dob_date + NO_END_DATE_DURATION,  # 2 days width for visibility
            "event": "Birth",
            "type": "Birth",
            "details": f"Subject {subject.get('subject_id', 'Unknown')} born",
            "data": subject_details,
        }
    except Exception as e:
        print(f"[parse_birth] Error parsing birth: {e}")
        return None


def parse_procedure(proc):
    """Parse procedure event from procedure data."""
    if not proc:
        return None

    proc_type = proc.get("object_type", "Procedure")
    start_date = proc.get("start_date")
    end_date = proc.get("end_date")

    if not start_date:
        return None

    try:
        start_dt = normalize_timestamp(start_date)

        # Use end_date if available, otherwise use a fixed width for visibility
        if end_date:
            end_dt = normalize_timestamp(end_date)
        else:
            # Use 2 days width for visibility/clickability, like birth events
            end_dt = start_dt + NO_END_DATE_DURATION

        # Get procedure details
        if proc_type == "Surgery":
            sub_procs = proc.get("procedures", [])
            if sub_procs:
                detail_parts = [sp.get("object_type", "Unknown") for sp in sub_procs if sp]
                detail_str = ", ".join(detail_parts) if detail_parts else "Surgery"
            else:
                detail_str = "Surgery"
        else:
            detail_str = proc_type

        return {
            "start": start_dt,
            "end": end_dt,
            "event": proc_type,
            "type": proc_type,
            "details": detail_str,
            "data": proc,
        }
    except Exception as e:
        print(f"[parse_procedure] Error parsing procedure: {e}")
        return None


def parse_session(data_desc):
    """Parse session event from data description."""
    from datetime import datetime

    if not data_desc:
        return None

    creation_time = data_desc.get("creation_time")
    if not creation_time:
        return None

    try:
        dt = datetime.fromisoformat(creation_time.replace("+00:00", ""))
        start_dt = pd.to_datetime(dt)
        # Sessions typically last hours
        end_dt = start_dt + timedelta(hours=4)

        return {
            "start": start_dt,
            "end": end_dt,
            "event": "Session",
            "type": "Session",
            "details": f"Data session: {data_desc.get('name', 'Unknown')}",
            "data": data_desc,
        }
    except Exception as e:
        print(f"[parse_session] Error parsing session: {e}")
        return None


def parse_acquisition(acquisition):
    """Parse acquisition event with start and end times."""
    from datetime import datetime

    if not acquisition:
        return None

    start_time = acquisition.get("acquisition_start_time")
    end_time = acquisition.get("acquisition_end_time")

    if not start_time or not end_time:
        return None

    try:
        start_dt = normalize_timestamp(start_time)
        end_dt = normalize_timestamp(end_time)

        # Get acquisition type or session type for the label
        acq_type = acquisition.get("acquisition_type") or acquisition.get("session_type", "Acquisition")
        protocol = acquisition.get("protocol_name", "")

        event_label = f"{acq_type}"
        if protocol:
            event_label += f" ({protocol})"

        return {
            "start": start_dt,
            "end": end_dt,
            "event": event_label,
            "type": "Acquisition",
            "details": f"Duration: {(end_dt - start_dt).total_seconds() / 3600:.1f} hours",
            "data": acquisition,
        }
    except Exception as e:
        print(f"[parse_acquisition] Error parsing acquisition: {e}")
        return None


def parse_perfusion(proc, surgery_date=None):
    """Parse perfusion procedure (surgery sub-procedure)."""
    if not proc:
        return None

    # Perfusion procedures are typically part of a surgery
    # If surgery_date is provided, use it; otherwise look for start_date
    start_date = surgery_date or proc.get("start_date")

    if not start_date:
        return None

    try:
        start_dt = normalize_timestamp(start_date)
        # Perfusion is typically quick (1-2 hours)
        end_dt = start_dt + timedelta(hours=1)

        protocol_id = proc.get("protocol_id", "Unknown")
        specimen_ids = proc.get("output_specimen_ids", [])
        specimen_str = ", ".join(specimen_ids) if specimen_ids else "Unknown"

        return {
            "start": start_dt,
            "end": end_dt,
            "event": "Perfusion",
            "type": "Perfusion",
            "details": f"Perfusion (specimen: {specimen_str})",
            "data": proc,
        }
    except Exception as e:
        print(f"[parse_perfusion] Error parsing perfusion: {e}")
        return None


def parse_brain_injection(proc, surgery_date=None):
    """Parse brain injection procedure (surgery sub-procedure)."""
    if not proc:
        return None

    # Brain injection procedures are typically part of a surgery
    start_date = surgery_date or proc.get("start_date")

    if not start_date:
        return None

    try:
        start_dt = normalize_timestamp(start_date)
        # Brain injection is typically 1-3 hours
        end_dt = start_dt + timedelta(hours=2)

        # Extract injection materials info
        materials = proc.get("injection_materials", [])
        material_names = []
        for mat in materials:
            if mat and mat.get("object_type") == "Viral material":
                name = mat.get("name", "Unknown")
                material_names.append(name)

        materials_str = ", ".join(material_names) if material_names else "Unknown"

        # Extract position info
        positions = proc.get("relative_position", [])
        position_str = ", ".join(positions) if positions else "Unknown"

        return {
            "start": start_dt,
            "end": end_dt,
            "event": "Brain injection",
            "type": "Brain injection",
            "details": f"Brain injection ({position_str}): {materials_str}",
            "data": proc,
        }
    except Exception as e:
        print(f"[parse_brain_injection] Error parsing brain injection: {e}")
        return None


def parse_generic_surgery_procedure(proc, surgery_date=None):
    """Parse generic surgery procedure (surgery sub-procedure)."""
    if not proc:
        return None

    # Generic surgery procedures are part of a surgery
    start_date = surgery_date or proc.get("start_date")

    if not start_date:
        return None

    try:
        start_dt = normalize_timestamp(start_date)
        # Generic procedure duration varies
        end_dt = start_dt + timedelta(hours=2)

        description = proc.get("description", "Generic surgery procedure")
        notes = proc.get("notes", "")

        details_str = description
        if notes:
            details_str += f" - {notes}"

        return {
            "start": start_dt,
            "end": end_dt,
            "event": "Generic surgery procedure",
            "type": "Generic surgery procedure",
            "details": details_str,
            "data": proc,
        }
    except Exception as e:
        print(f"[parse_generic_surgery_procedure] Error parsing generic surgery procedure: {e}")
        return None


def parse_specimen_procedure(proc):
    """Parse specimen procedure."""
    if not proc:
        return None

    start_date = proc.get("start_date")
    end_date = proc.get("end_date")

    if not start_date:
        return None

    try:
        start_dt = normalize_timestamp(start_date)

        # Use end_date if available, otherwise use 1 day duration
        if end_date:
            end_dt = normalize_timestamp(end_date)
        else:
            end_dt = start_dt + NO_END_DATE_DURATION

        procedure_type = proc.get("procedure_type", "Unknown")
        procedure_name = proc.get("procedure_name", "Unknown")
        specimen_id = proc.get("specimen_id", "Unknown")

        # Extract reagent info if available
        details_list = proc.get("procedure_details", [])
        reagents = []
        for detail in details_list:
            if detail and detail.get("object_type") == "Reagent":
                reagent_name = detail.get("name", "Unknown")
                lot_number = detail.get("lot_number")
                if lot_number:
                    reagents.append(f"{reagent_name} (lot: {lot_number})")
                else:
                    reagents.append(reagent_name)

        # Build details string
        details_parts = [procedure_name]
        if reagents:
            details_parts.append(f"Reagents: {', '.join(reagents)}")
        if specimen_id != "Unknown":
            details_parts.append(f"Specimen: {specimen_id}")

        details_str = " - ".join(details_parts)

        return {
            "start": start_dt,
            "end": end_dt,
            "event": procedure_type,
            "type": procedure_type,
            "details": details_str,
            "data": proc,
        }
    except Exception as e:
        print(f"[parse_specimen_procedure] Error parsing specimen procedure: {e}")
        return None


def parse_fiber_implant(proc, surgery_date=None):
    """Parse fiber implant procedure (surgery sub-procedure)."""
    if not proc:
        return None

    # Fiber implant procedures are typically part of a surgery
    start_date = surgery_date or proc.get("start_date")

    if not start_date:
        return None

    try:
        start_dt = normalize_timestamp(start_date)
        # Fiber implant surgery is typically 2-3 hours
        end_dt = start_dt + timedelta(hours=2)

        # Check for device_config (fiber probe info)
        device_config = proc.get("device_config")
        if device_config:
            device_name = device_config.get("device_name", "Unknown")
            details_str = f"Fiber probe implant ({device_name})"
        else:
            details_str = "Probe implant"

        return {
            "start": start_dt,
            "end": end_dt,
            "event": "Probe implant",
            "type": "Probe implant",
            "details": details_str,
            "data": proc,
            "has_fiber_visualization": True,  # Flag to indicate special visualization available
        }
    except Exception as e:
        print(f"[parse_fiber_implant] Error parsing fiber implant: {e}")
        return None
