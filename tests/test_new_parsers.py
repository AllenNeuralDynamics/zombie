"""Tests for new parsers handling all procedure types in 704242.json."""

import json
from pathlib import Path
import pytest

from zombie.subject_contents.procedures.parsers import (
    parse_birth,
    parse_procedure,
    parse_session,
    parse_perfusion,
    parse_brain_injection,
    parse_generic_surgery_procedure,
    parse_specimen_procedure
)


@pytest.fixture
def metadata_704242():
    """Load the 704242.json test data."""
    test_file = Path(__file__).parent / "resources" / "704242.json"
    with open(test_file, 'r') as f:
        return json.load(f)


def test_parse_birth(metadata_704242):
    """Test birth event parsing."""
    subject = metadata_704242.get("subject", {})
    event = parse_birth(subject)
    
    assert event is not None
    assert event["event"] == "Birth"
    assert event["type"] == "Birth"
    assert "704242" in event["details"]
    assert event["start"] is not None
    assert event["end"] is not None


def test_parse_session(metadata_704242):
    """Test session event parsing."""
    data_desc = metadata_704242.get("data_description", {})
    event = parse_session(data_desc)
    
    assert event is not None
    assert event["event"] == "Session"
    assert event["type"] == "Session"
    assert "ecephys_704242_2024-05-02_16-51-50" in event["details"]
    assert event["start"] is not None
    assert event["end"] is not None


def test_parse_surgery_procedures(metadata_704242):
    """Test parsing all surgery procedures."""
    procedures = metadata_704242.get("procedures", {})
    subject_procedures = procedures.get("subject_procedures", [])
    
    # Find all surgery procedures
    surgeries = [p for p in subject_procedures if p.get("object_type") == "Surgery"]
    assert len(surgeries) == 3
    
    # Parse each surgery
    for surgery in surgeries:
        event = parse_procedure(surgery)
        assert event is not None
        assert event["event"] == "Surgery"
        assert event["type"] == "Surgery"
        assert event["start"] is not None
        assert event["end"] is not None


def test_parse_perfusion(metadata_704242):
    """Test parsing perfusion sub-procedure."""
    procedures = metadata_704242.get("procedures", {})
    subject_procedures = procedures.get("subject_procedures", [])
    
    # Find surgery with perfusion
    perfusion_surgery = None
    for surgery in subject_procedures:
        if surgery.get("object_type") == "Surgery":
            sub_procs = surgery.get("procedures", [])
            for sp in sub_procs:
                if sp.get("object_type") == "Perfusion":
                    perfusion_surgery = surgery
                    perfusion_proc = sp
                    break
    
    assert perfusion_surgery is not None
    assert perfusion_proc is not None
    
    # Parse perfusion with surgery date
    event = parse_perfusion(perfusion_proc, surgery_date=perfusion_surgery.get("start_date"))
    
    assert event is not None
    assert event["event"] == "Perfusion"
    assert event["type"] == "Perfusion"
    assert "704242" in event["details"]
    assert event["start"] is not None
    assert event["end"] is not None


def test_parse_brain_injection(metadata_704242):
    """Test parsing brain injection sub-procedure."""
    procedures = metadata_704242.get("procedures", {})
    subject_procedures = procedures.get("subject_procedures", [])
    
    # Find surgery with brain injection
    injection_surgery = None
    for surgery in subject_procedures:
        if surgery.get("object_type") == "Surgery":
            sub_procs = surgery.get("procedures", [])
            for sp in sub_procs:
                if sp.get("object_type") == "Brain injection":
                    injection_surgery = surgery
                    injection_proc = sp
                    break
    
    assert injection_surgery is not None
    assert injection_proc is not None
    
    # Parse brain injection with surgery date
    event = parse_brain_injection(injection_proc, surgery_date=injection_surgery.get("start_date"))
    
    assert event is not None
    assert event["event"] == "Brain injection"
    assert event["type"] == "Brain injection"
    assert "Left" in event["details"]  # relative position
    assert "ChRmine" in event["details"]  # viral material
    assert event["start"] is not None
    assert event["end"] is not None


def test_parse_generic_surgery_procedure(metadata_704242):
    """Test parsing generic surgery procedure."""
    procedures = metadata_704242.get("procedures", {})
    subject_procedures = procedures.get("subject_procedures", [])
    
    # Find surgery with generic procedure
    generic_surgery = None
    for surgery in subject_procedures:
        if surgery.get("object_type") == "Surgery":
            sub_procs = surgery.get("procedures", [])
            for sp in sub_procs:
                if sp.get("object_type") == "Generic surgery procedure":
                    generic_surgery = surgery
                    generic_proc = sp
                    break
    
    assert generic_surgery is not None
    assert generic_proc is not None
    
    # Parse generic procedure with surgery date
    event = parse_generic_surgery_procedure(generic_proc, surgery_date=generic_surgery.get("start_date"))
    
    assert event is not None
    assert event["event"] == "Generic surgery procedure"
    assert event["type"] == "Generic surgery procedure"
    assert event["details"] is not None
    assert event["start"] is not None
    assert event["end"] is not None


def test_parse_specimen_procedures(metadata_704242):
    """Test parsing all specimen procedures."""
    procedures = metadata_704242.get("procedures", {})
    specimen_procedures = procedures.get("specimen_procedures", [])
    
    assert len(specimen_procedures) == 6
    
    procedure_types = set()
    procedure_names = set()
    
    for proc in specimen_procedures:
        event = parse_specimen_procedure(proc)
        
        assert event is not None
        assert event["type"] in ["Fixation", "Delipidation", "Refractive index matching"]
        assert event["start"] is not None
        assert event["end"] is not None
        assert "704242" in event["details"]
        
        procedure_types.add(event["type"])
        procedure_names.add(proc.get("procedure_name"))
    
    # Check that we have all expected types
    assert "Fixation" in procedure_types
    assert "Delipidation" in procedure_types
    assert "Refractive index matching" in procedure_types
    
    # Check specific procedure names
    assert "SHIELD OFF" in procedure_names
    assert "SHIELD ON" in procedure_names
    assert "24h Delipidation" in procedure_names
    assert "Active Delipidation" in procedure_names
    assert "50% EasyIndex" in procedure_names
    assert "100% EasyIndex" in procedure_names


def test_parse_specimen_procedure_with_reagents(metadata_704242):
    """Test that specimen procedures properly extract reagent information."""
    procedures = metadata_704242.get("procedures", {})
    specimen_procedures = procedures.get("specimen_procedures", [])
    
    # Find a procedure with reagents (e.g., SHIELD OFF)
    shield_off = None
    for proc in specimen_procedures:
        if proc.get("procedure_name") == "SHIELD OFF":
            shield_off = proc
            break
    
    assert shield_off is not None
    
    event = parse_specimen_procedure(shield_off)
    
    assert event is not None
    assert "Reagents:" in event["details"]
    assert "SHIELD Epoxy" in event["details"] or "SHIELD Buffer" in event["details"]
    assert "lot:" in event["details"]  # Lot numbers should be included
