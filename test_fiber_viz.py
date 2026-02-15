"""
Simple test app to verify fiber implant visualization works with hvplot.
"""
import json
import panel as pn
from src.zombie.subject_contents.procedures.fiber_implant_parser import extract_fibers_from_surgery
from src.zombie.subject_contents.procedures.fiber_implant_details import create_fiber_implant_details_pane

pn.extension()

# Load test data
with open('tests/resources/813992.json', 'r') as f:
    data = json.load(f)

# Extract procedures
procedures_obj = data.get('procedures', {})
subject_procedures = procedures_obj.get('subject_procedures', [])
surgery_data = None
for proc in subject_procedures:
    if proc.get('object_type') == 'Surgery':
        surgery_data = proc
        break

if surgery_data:
    # Extract fibers
    fibers = extract_fibers_from_surgery(surgery_data)
    print(f"Found {len(fibers)} fibers")
    for fiber in fibers:
        print(f"  {fiber['name']}: AP={fiber['ap']}, ML={fiber['ml']}, DV={fiber['dv']}")
    
    # Create visualization
    viz_pane = create_fiber_implant_details_pane(surgery_data, '813992')
    
    # Create app
    app = pn.Column(
        "# Fiber Implant Visualization Test",
        viz_pane
    )
    
    app.servable()
    app.show()
else:
    print("No surgery data found!")
