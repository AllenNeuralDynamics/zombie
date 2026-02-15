"""Tests for fiber implant parser functions."""

import json
from pathlib import Path
import unittest

from zombie.subject_contents.procedures.fiber_implant_parser import (
    extract_fiber_metadata,
    extract_fibers_from_surgery,
    has_fiber_implants,
    get_fiber_index,
    safe_float,
)


class TestFiberImplantParser(unittest.TestCase):
    """Test cases for fiber implant parser functions."""

    @classmethod
    def setUpClass(cls):
        """Load test data once for all tests."""
        test_file = Path(__file__).parent / "resources" / "813992.json"
        with open(test_file, "r") as f:
            cls.metadata_813992 = json.load(f)

        # Extract surgery with fiber implants
        procedures = cls.metadata_813992.get("procedures", {})
        subject_procedures = procedures.get("subject_procedures", [])
        cls.surgery_with_fibers = subject_procedures[0]

    def test_safe_float(self):
        """Test safe_float helper function."""
        self.assertEqual(safe_float(1.5), 1.5)
        self.assertEqual(safe_float("2.5"), 2.5)
        self.assertEqual(safe_float(None), 0.0)
        self.assertEqual(safe_float(None, default=5.0), 5.0)
        self.assertEqual(safe_float("invalid"), 0.0)
        self.assertEqual(safe_float("invalid", default=10.0), 10.0)

    def test_get_fiber_index(self):
        """Test get_fiber_index helper function."""
        self.assertEqual(get_fiber_index({"name": "Fiber_0"}), 0)
        self.assertEqual(get_fiber_index({"name": "Fiber_1"}), 1)
        self.assertEqual(get_fiber_index({"name": "Fiber_10"}), 10)
        self.assertEqual(get_fiber_index({"name": "Unknown"}), 999)
        self.assertEqual(get_fiber_index({"name": "InvalidName"}), 999)
        self.assertEqual(get_fiber_index({}), 999)

    def test_extract_fiber_metadata_from_real_data(self):
        """Test extracting fiber metadata from real 813992 data."""
        # Get the first probe implant (Fiber_0)
        probe_implant = None
        for proc in self.surgery_with_fibers.get("procedures", []):
            if proc.get("object_type") == "Probe implant":
                probe_implant = proc
                break

        self.assertIsNotNone(probe_implant, "Should find probe implant")

        device_config = probe_implant.get("device_config")
        self.assertIsNotNone(device_config, "Device config should exist")

        # Extract fiber metadata
        fiber = extract_fiber_metadata(device_config)

        # Check extracted fields
        self.assertEqual(fiber["name"], "Fiber_0")
        self.assertEqual(fiber["ap"], 1.3)
        self.assertEqual(fiber["ml"], -1.8)
        self.assertEqual(fiber["dv"], 0)
        self.assertEqual(fiber["angle"], 0)
        self.assertEqual(fiber["unit"], "millimeter")
        self.assertEqual(fiber["reference"], "Tip")
        self.assertEqual(fiber["targeted_structure"], "Nucleus accumbens")

    def test_extract_all_fibers_from_surgery(self):
        """Test extracting all fiber implants from surgery."""
        fibers = extract_fibers_from_surgery(self.surgery_with_fibers)

        # Should find 3 fiber implants (Fiber_0, Fiber_1, Fiber_2)
        self.assertEqual(len(fibers), 3)

        # Check Fiber_0
        fiber_0 = next(f for f in fibers if f["name"] == "Fiber_0")
        self.assertEqual(fiber_0["ap"], 1.3)
        self.assertEqual(fiber_0["ml"], -1.8)
        self.assertEqual(fiber_0["targeted_structure"], "Nucleus accumbens")

        # Check Fiber_1
        fiber_1 = next(f for f in fibers if f["name"] == "Fiber_1")
        self.assertEqual(fiber_1["ap"], 1.1)
        self.assertEqual(fiber_1["ml"], 1.8)
        self.assertEqual(fiber_1["targeted_structure"], "Nucleus accumbens")

        # Check Fiber_2
        fiber_2 = next(f for f in fibers if f["name"] == "Fiber_2")
        self.assertEqual(fiber_2["ap"], -1.5)
        self.assertEqual(fiber_2["ml"], 3.0)
        self.assertEqual(fiber_2["targeted_structure"], "Basolateral amygdalar nucleus")

    def test_fibers_sorted_by_index(self):
        """Test that fibers can be sorted by index."""
        fibers = extract_fibers_from_surgery(self.surgery_with_fibers)
        sorted_fibers = sorted(fibers, key=get_fiber_index)

        # Should be sorted: Fiber_0, Fiber_1, Fiber_2
        self.assertEqual(sorted_fibers[0]["name"], "Fiber_0")
        self.assertEqual(sorted_fibers[1]["name"], "Fiber_1")
        self.assertEqual(sorted_fibers[2]["name"], "Fiber_2")

    def test_has_fiber_implants(self):
        """Test has_fiber_implants detection."""
        self.assertTrue(has_fiber_implants(self.surgery_with_fibers))

        # Test with surgery without fiber implants
        empty_surgery = {"procedures": []}
        self.assertFalse(has_fiber_implants(empty_surgery))

        # Test with surgery with other procedures
        surgery_no_fibers = {
            "procedures": [
                {"object_type": "Headframe"},
                {"object_type": "Brain injection"},
            ]
        }
        self.assertFalse(has_fiber_implants(surgery_no_fibers))

    def test_extract_fibers_handles_missing_data(self):
        """Test that extraction handles missing or malformed data gracefully."""
        # Empty surgery
        fibers = extract_fibers_from_surgery({})
        self.assertEqual(fibers, [])

        # Surgery with no procedures
        fibers = extract_fibers_from_surgery({"procedures": []})
        self.assertEqual(fibers, [])

        # Surgery with None in procedures
        fibers = extract_fibers_from_surgery({"procedures": [None]})
        self.assertEqual(fibers, [])

        # Probe implant with no device_config
        surgery = {"procedures": [{"object_type": "Probe implant"}]}
        fibers = extract_fibers_from_surgery(surgery)
        self.assertEqual(fibers, [])

    def test_extract_fiber_metadata_handles_incomplete_config(self):
        """Test that metadata extraction handles incomplete device configs."""
        # Minimal config
        config = {"device_name": "Fiber_X"}
        fiber = extract_fiber_metadata(config)

        self.assertEqual(fiber["name"], "Fiber_X")
        self.assertEqual(fiber["ap"], 0)
        self.assertEqual(fiber["ml"], 0)
        self.assertIsNone(fiber["dv"])
        self.assertEqual(fiber["angle"], 0)
        self.assertEqual(fiber["targeted_structure"], "Not specified in surgical request form")

        # Config with empty transform
        config = {"device_name": "Fiber_Y", "transform": []}
        fiber = extract_fiber_metadata(config)
        self.assertEqual(fiber["name"], "Fiber_Y")
        self.assertEqual(fiber["ap"], 0)
        self.assertEqual(fiber["ml"], 0)

    def test_extract_fiber_metadata_with_rotation(self):
        """Test extracting fiber metadata with rotation data."""
        # Find Fiber_2 which has rotation data
        fiber_2_proc = None
        for proc in self.surgery_with_fibers.get("procedures", []):
            if proc.get("object_type") == "Probe implant":
                device_config = proc.get("device_config", {})
                if device_config.get("device_name") == "Fiber_2":
                    fiber_2_proc = proc
                    break

        self.assertIsNotNone(fiber_2_proc)
        device_config = fiber_2_proc.get("device_config")

        # The rotation in the data has angles [0, 0, 0, 0]
        # Our parser takes the first element
        fiber = extract_fiber_metadata(device_config)
        self.assertEqual(fiber["angle"], 0)

    def test_coordinate_system_origin_extraction(self):
        """Test that coordinate system origin is extracted correctly."""
        probe_implant = None
        for proc in self.surgery_with_fibers.get("procedures", []):
            if proc.get("object_type") == "Probe implant":
                probe_implant = proc
                break

        device_config = probe_implant.get("device_config")
        fiber = extract_fiber_metadata(device_config)

        # The coordinate system origin in the data is "Tip"
        self.assertEqual(fiber["reference"], "Tip")


if __name__ == "__main__":
    unittest.main()
