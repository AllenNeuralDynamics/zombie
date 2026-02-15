from datetime import datetime, timedelta
import panel as pn
from panel.custom import PyComponent
import hvplot.pandas
import pandas as pd
import param
import holoviews as hv
from holoviews import streams

from zombie.subject_contents.procedures.parsers import (
    parse_birth, 
    parse_procedure, 
    parse_session,
    parse_perfusion,
    parse_brain_injection,
    parse_generic_surgery_procedure,
    parse_specimen_procedure,
    parse_fiber_implant,
    parse_acquisition,
)
from zombie.subject_contents.procedures.fiber_implant_details import (
    create_fiber_implant_details_pane,
)
from zombie.subject_contents.procedures.fiber_implant_parser import (
    has_fiber_implants,
)
from zombie.subject_contents.procedures.brain_injection_details import (
    create_brain_injection_details_pane,
)
from zombie.subject_contents.procedures.brain_injection_parser import (
    has_brain_injections,
)


class TimelineView(PyComponent):
    """Timeline view showing subject procedures and key dates."""
    
    subject_data = param.Dict(default={})
    selected_event = param.Dict(default={})
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.plot_pane = pn.pane.HoloViews(sizing_mode="stretch_width", height=500)
        self.message_pane = pn.pane.Markdown("Loading...", sizing_mode="stretch_width")
        # Use a Column for detail_pane so it can hold any type of content (Markdown or Tabs)
        self.detail_container = pn.Column(
            pn.pane.Markdown("Click on a timeline event to see details", sizing_mode="stretch_width"),
            sizing_mode="stretch_width"
        )
        self.tap_stream = None
        
        self.panel = pn.Column(
            pn.pane.Markdown("### Subject Timeline", sizing_mode="stretch_width"),
            self.message_pane,
            self.plot_pane,
            pn.layout.Divider(),
            pn.pane.Markdown("#### Event Details", sizing_mode="stretch_width", margin=(20, 0, 10, 0)),
            self.detail_container,
            sizing_mode="stretch_width",
        )
        
    @param.depends("subject_data", watch=True)
    def _update_plot(self):
        """Update the timeline plot based on subject data."""
        if not self.subject_data:
            self.message_pane.object = "No data available"
            self.plot_pane.object = None
            return
        
        self.message_pane.object = ""
            
        # Extract timeline events
        events = []
        
        # Add date of birth
        subject = self.subject_data.get("subject", {})
        birth_event = parse_birth(subject)
        if birth_event:
            events.append(birth_event)
        
        # Add procedures
        procedures = self.subject_data.get("procedures", {})
        subject_procedures = procedures.get("subject_procedures", [])
        
        for proc in subject_procedures:
            proc_event = parse_procedure(proc)
            if proc_event:
                events.append(proc_event)
                
                # Note: Sub-procedures are NOT added to timeline
                # They are only shown in the Surgery tabs when you click the Surgery event
        
        # Add specimen procedures
        specimen_procedures = procedures.get("specimen_procedures", [])
        for spec_proc in specimen_procedures:
            spec_event = parse_specimen_procedure(spec_proc)
            if spec_event:
                events.append(spec_event)
        
        # Add all acquisitions
        acquisitions = self.subject_data.get("acquisitions", [])
        for acquisition in acquisitions:
            acq_event = parse_acquisition(acquisition)
            if acq_event:
                events.append(acq_event)
        
        if not events:
            self.message_pane.object = "No timeline events found"
            self.plot_pane.object = None
            return
        
        # Create DataFrame
        df = pd.DataFrame(events)
        df = df.sort_values("start")
        
        # Store for later access
        self.events_df = df
        
        # Calculate age in days from birth
        if len(df) > 0 and df.iloc[0]["type"] == "Birth":
            birth_date = df.iloc[0]["start"]
            df["age_days"] = (df["start"] - birth_date).dt.days
        else:
            df["age_days"] = 0
        
        # Create rectangles for timeline - use x0, x1, y0, y1 format
        rect_data = []
        for idx, row in df.iterrows():
            rect_data.append({
                "x0": row["start"],
                "x1": row["end"],
                "y0": 0,
                "y1": 1,
                "event": row["event"],
                "type": row["type"],
                "details": row["details"],
                "age_days": row["age_days"]
            })
        
        rect_df = pd.DataFrame(rect_data)
        
        # Create timeline plot using rectangles
        rectangles = hv.Rectangles(
            rect_df,
            kdims=["x0", "y0", "x1", "y1"],
            vdims=["event", "type", "details", "age_days"]
        ).opts(
            color="type",
            cmap="Category20",
            tools=["hover", "tap"],
            active_tools=["tap"],
            height=200,
            width=1200,
            title="Subject Timeline",
            xlabel="Date",
            yaxis=None,
            ylim=(-0.5, 2.5),
            show_legend=False,
            xrotation=45,
        )
        
        # Add text labels above each segment
        label_df = df.copy()
        label_df["x"] = df["start"] + (df["end"] - df["start"]) / 2
        label_df["label_y"] = 1.5
        
        labels = hv.Labels(
            label_df,
            kdims=["x", "label_y"],
            vdims=["event"]
        ).opts(
            angle=45,
            text_font_size="10pt",
            text_align="left"
        )
        
        plot = (rectangles * labels)
        
        # Set up tap stream for interactivity - connect to the rectangles layer
        if self.tap_stream is None:
            print("[Timeline] Creating new tap stream")
            self.tap_stream = hv.streams.Tap(source=rectangles)
            print(f"[Timeline] Tap stream created: {self.tap_stream}")
            print(f"[Timeline] Tap stream source: {self.tap_stream.source}")
            # Use param.watch instead of self.tap_stream.param.watch
            self.tap_stream.param.watch(self._on_tap, ["x", "y"])
            print(f"[Timeline] Watch callback registered")
        else:
            print("[Timeline] Reusing existing tap stream")
            self.tap_stream.source = rectangles
        
        print(f"[Timeline] Plot updated with {len(df)} events")
        print(f"[Timeline] Tap stream after setup: {self.tap_stream}")
        self.plot_pane.object = plot
    
    def _on_tap(self, *events):
        """Handle tap events on timeline."""
        print(f"[Timeline._on_tap] Called! events={events}")
        print(f"[Timeline._on_tap] tap_stream.x={self.tap_stream.x}, tap_stream.y={self.tap_stream.y}")
        
        if self.tap_stream.x is None or not hasattr(self, "events_df"):
            print(f"[Timeline._on_tap] Early return: x={self.tap_stream.x}, has events_df={hasattr(self, 'events_df')}")
            return
        
        print(f"[Timeline._on_tap] Processing tap at x={self.tap_stream.x}")
        
        # Convert tap_stream.x to timestamp - it can be either numeric (ms) or datetime
        tap_x = self.tap_stream.x
        if isinstance(tap_x, pd.Timestamp):
            tap_time = tap_x
        elif hasattr(tap_x, 'dtype') and 'datetime' in str(tap_x.dtype):
            tap_time = pd.to_datetime(tap_x)
        else:
            # Assume it's in milliseconds
            tap_time = pd.to_datetime(tap_x, unit='ms')
        
        # Ensure tap_time is timezone-aware UTC to match events_df
        if tap_time.tz is None:
            tap_time = tap_time.tz_localize('UTC')
        else:
            tap_time = tap_time.tz_convert('UTC')
        
        print(f"[Timeline._on_tap] Tap time: {tap_time}")
        
        # Find events that contain this time
        mask = (self.events_df["start"] <= tap_time) & (self.events_df["end"] >= tap_time)
        matching = self.events_df[mask]
        print(f"[Timeline._on_tap] Found {len(matching)} matching events")
        
        if len(matching) > 0:
            # Take the first match
            selected = matching.iloc[0].to_dict()
            print(f"[Timeline._on_tap] Selected event: {selected.get('event')} ({selected.get('type')})")
            self.selected_event = selected
            self._update_detail_pane(selected)
        else:
            # Find closest event if no direct hit
            print(f"[Timeline._on_tap] No direct hit, finding closest event")
            # Calculate midpoint of each event
            midpoints = self.events_df["start"] + (self.events_df["end"] - self.events_df["start"]) / 2
            
            # Calculate distance between tap and midpoints (as timedeltas)
            distances = abs(midpoints - tap_time)
            # Convert timedelta to seconds for comparison
            distance_seconds = distances.dt.total_seconds()
            
            closest_idx = distance_seconds.idxmin()
            selected = self.events_df.loc[closest_idx].to_dict()
            print(f"[Timeline._on_tap] Closest event: {selected.get('event')} ({selected.get('type')})")
            self.selected_event = selected
            self._update_detail_pane(selected)
    
    def _update_detail_pane(self, event):
        """Update the detail pane based on selected event type."""
        if not event:
            self.detail_container.clear()
            self.detail_container.append(pn.pane.Markdown("Click on a timeline event to see details", sizing_mode="stretch_width"))
            return
        
        event_type = event.get("type", "Unknown")
        event_name = event.get("event", "Unknown")
        details = event.get("details", "")
        start = event.get("start")
        end = event.get("end")
        data = event.get("data", {})
        
        # Format based on type
        if event_type == "Birth":
            md = f"""
**Birth**
- Date: {start.strftime("%Y-%m-%d")}
- Details: {details}
"""
            self.detail_container.clear()
            self.detail_container.append(pn.pane.Markdown(md, sizing_mode="stretch_width"))
            
        elif event_type == "Surgery":
            # For surgeries, create tabs for each sub-procedure
            overview_md = f"""
**Surgery Overview**
- Date: {start.strftime("%Y-%m-%d")}
- Procedures: {details}
"""
            # Add more surgery details if available
            if "anaesthesia" in data:
                anaes = data["anaesthesia"]
                if anaes is not None:
                    overview_md += f"- Anaesthesia: {anaes.get('anaesthetic_type', 'Unknown')} at {anaes.get('level', 'Unknown')} for {anaes.get('duration', 'Unknown')} {anaes.get('duration_unit', '')}\n"
            if "animal_weight_prior" in data:
                overview_md += f"- Weight before: {data['animal_weight_prior']} {data.get('weight_unit', 'g')}\n"
            if "animal_weight_post" in data:
                overview_md += f"- Weight after: {data['animal_weight_post']} {data.get('weight_unit', 'g')}\n"
            if "workstation_id" in data and data.get("workstation_id"):
                overview_md += f"- Workstation: {data['workstation_id']}\n"
            if "experimenters" in data:
                experimenters = data.get("experimenters", [])
                if experimenters:
                    overview_md += f"- Experimenters: {', '.join(experimenters)}\n"
            
            # Create tabs for each sub-procedure
            tabs = [("Overview", pn.pane.Markdown(overview_md, sizing_mode="stretch_width"))]
            
            sub_procs = data.get("procedures", [])
            for idx, sub_proc in enumerate(sub_procs):
                sub_type = sub_proc.get("object_type", "Unknown")
                
                # Skip Probe implant and Brain injection sub-procedures - they'll be shown in dedicated tabs
                if sub_type in ["Probe implant", "Brain injection"]:
                    continue
                
                tab_md = f"**{sub_type}**\n\n"
                
                if sub_type == "Perfusion":
                    protocol = sub_proc.get("protocol_id", "Not specified")
                    specimens = sub_proc.get("output_specimen_ids", [])
                    tab_md += f"- Protocol: {protocol}\n"
                    if specimens:
                        tab_md += f"- Output specimens: {', '.join(specimens)}\n"
                    
                elif sub_type == "Generic surgery procedure":
                    description = sub_proc.get("description", "No description")
                    tab_md += f"- Description: {description}\n"
                    notes = sub_proc.get("notes")
                    if notes:
                        tab_md += f"- Notes: {notes}\n"
                
                tabs.append((sub_type, pn.pane.Markdown(tab_md, sizing_mode="stretch_width")))
            
            # Add brain injection tab if surgery has injections
            if has_brain_injections(data):
                print(f"[_update_detail_pane] Surgery has brain injections, creating viz pane")
                subject_id = "Unknown"
                if hasattr(self, "subject_data") and self.subject_data:
                    subject = self.subject_data.get("subject", {})
                    subject_id = subject.get("subject_id", "Unknown")
                
                injection_viz_pane = create_brain_injection_details_pane(data, subject_id)
                print(f"[_update_detail_pane] Adding Brain Injections tab")
                tabs.append(("Brain Injections", injection_viz_pane))
            
            # Add fiber locations tab if surgery has fiber implants
            if has_fiber_implants(data):
                print(f"[_update_detail_pane] Surgery has fiber implants, creating viz pane")
                subject_id = "Unknown"
                if hasattr(self, "subject_data") and self.subject_data:
                    subject = self.subject_data.get("subject", {})
                    subject_id = subject.get("subject_id", "Unknown")
                
                fiber_viz_pane = create_fiber_implant_details_pane(data, subject_id)
                print(f"[_update_detail_pane] fiber_viz_pane type: {type(fiber_viz_pane)}")
                print(f"[_update_detail_pane] Adding Fiber Locations tab")
                tabs.append(("Fiber Locations", fiber_viz_pane))
                print(f"[_update_detail_pane] Total tabs: {len(tabs)}")
            
            # Clear and add Tabs widget to detail_container
            print(f"[_update_detail_pane] Creating Tabs widget with {len(tabs)} tabs")
            self.detail_container.clear()
            tabs_widget = pn.Tabs(*tabs, sizing_mode="stretch_width")
            print(f"[_update_detail_pane] Tabs widget created, adding to detail_container")
            self.detail_container.append(tabs_widget)
            print(f"[_update_detail_pane] Detail container updated")
            
        elif event_type == "Session":
            md = f"""
**{event_name}**
- Date: {start.strftime("%Y-%m-%d %H:%M:%S")}
- Details: {details}
"""
            self.detail_container.clear()
            self.detail_container.append(pn.pane.Markdown(md, sizing_mode="stretch_width"))
            
        elif event_type == "Acquisition":
            duration_hours = (end - start).total_seconds() / 3600
            md = f"""
**{event_name}**
- Start: {start.strftime("%Y-%m-%d %H:%M:%S")}
- End: {end.strftime("%Y-%m-%d %H:%M:%S")}
- Duration: {duration_hours:.2f} hours
- Details: {details}
"""
            # Add additional acquisition details
            if "acquisition_type" in data:
                md += f"\n- Acquisition Type: {data['acquisition_type']}\n"
            if "session_type" in data:
                md += f"- Session Type: {data['session_type']}\n"
            if "protocol_name" in data:
                md += f"- Protocol: {data['protocol_name']}\n"
            if "experimenter_full_name" in data:
                experimenters = data['experimenter_full_name']
                if isinstance(experimenters, list):
                    md += f"- Experimenter: {', '.join(experimenters)}\n"
                else:
                    md += f"- Experimenter: {experimenters}\n"
            if "reward_consumed_total" in data:
                unit = data.get('reward_consumed_unit', '')
                md += f"- Reward Consumed: {data['reward_consumed_total']} {unit}\n"
            
            self.detail_container.clear()
            self.detail_container.append(pn.pane.Markdown(md, sizing_mode="stretch_width"))
            
        elif event_type in ["Perfusion", "Brain injection", "Generic surgery procedure"]:
            # These are sub-procedures shown on timeline
            md = f"""
**{event_name}** (Part of Surgery)
- Type: {event_type}
- Date: {start.strftime("%Y-%m-%d")}
- Details: {details}
"""
            # Add reference to parent surgery if available
            if "parent_surgery" in event:
                parent = event["parent_surgery"]
                md += f"\n- Parent surgery date: {parent.get('start_date')}\n"
            
            self.detail_container.clear()
            self.detail_container.append(pn.pane.Markdown(md, sizing_mode="stretch_width"))
        
        elif event_type == "Probe implant":
            # Fiber implant with special visualization
            md = f"""
**{event_name}** (Part of Surgery)
- Type: {event_type}
- Date: {start.strftime("%Y-%m-%d")}
- Details: {details}
"""
            # Add reference to parent surgery if available
            if "parent_surgery" in event:
                parent = event["parent_surgery"]
                md += f"\n- Parent surgery date: {parent.get('start_date')}\n"
            
            # Create the fiber visualization pane
            parent_surgery = event.get("parent_surgery", {})
            subject_id = "Unknown"
            # Try to get subject_id from subject_data
            if hasattr(self, "subject_data") and self.subject_data:
                subject = self.subject_data.get("subject", {})
                subject_id = subject.get("subject_id", "Unknown")
            
            fiber_viz_pane = create_fiber_implant_details_pane(parent_surgery, subject_id)
            
            # Create tabs with overview and visualization
            overview_pane = pn.pane.Markdown(md, sizing_mode="stretch_width")
            tabs = pn.Tabs(
                ("Overview", overview_pane),
                ("Fiber Locations", fiber_viz_pane),
                sizing_mode="stretch_width"
            )
            
            self.detail_container.clear()
            self.detail_container.append(tabs)
            
        elif event_type in ["Fixation", "Delipidation", "Refractive index matching"]:
            # Specimen procedures
            md = f"""
**{event_name}** (Specimen Procedure)
- Type: {event_type}
- Start: {start.strftime("%Y-%m-%d")}
- End: {end.strftime("%Y-%m-%d")}
- Duration: {(end - start).days} days
- Details: {details}
"""
            # Add notes if available
            if "notes" in data and data.get("notes"):
                md += f"\n- Notes: {data['notes']}\n"
            
            self.detail_container.clear()
            self.detail_container.append(pn.pane.Markdown(md, sizing_mode="stretch_width"))
            
        else:
            md = f"""
**{event_name}**
- Type: {event_type}
- Date: {start.strftime("%Y-%m-%d")}
- Details: {details}
"""
            self.detail_container.clear()
            self.detail_container.append(pn.pane.Markdown(md, sizing_mode="stretch_width"))
    
    def __panel__(self):
        return self.panel
