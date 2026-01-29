"""Author Contribution Matrix Panel App

This app allows users to specify author contributions using the CReDIT taxonomy
and generate LaTeX output for publication.
"""

import panel as pn
import pandas as pd
import param
from aind_data_access_api.document_db import MetadataDbClient
from io import StringIO
from zombie.layout import OUTER_STYLE, format_css_background

pn.extension('tabulator')
format_css_background()

# CReDIT Taxonomy Categories
CREDIT_CATEGORIES = [
    "Conceptualization",
    "Formal analysis",
    "Investigation",
    "Methodology",
    "Resources",
    "Software",
    "Writing---Original Draft",
    "Writing---Reviewing and Editing",
    "Funding acquisition",
]

# Contribution level mapping
CONTRIBUTION_LEVELS = {
    "None": 0,
    "Low": "\\lo",
    "High": "\\hi",
}

class ContributionMatrix(param.Parameterized):
    asset_name = param.String(default='multiplane-ophys_804670_2025-09-17_10-26-00_processed_2025-09-18_18-01-45')
    
    def __init__(self, **params):
        super().__init__(**params)
        
        self.client = MetadataDbClient(
            host='api.allenneuraldynamics.org',
            version='v2',
        )
        
        # Sync asset_name with URL
        pn.state.location.sync(self, {'asset_name': 'asset_name'})
        
        # Fetch the records
        self.records = self._fetch_records()
        
        # Extract authors
        self.authors = self._extract_authors()
        
        # Initialize contribution data
        self.contributions_df = self._initialize_contributions()
        
        # Create UI
        self._create_ui()
        
        # Watch for asset_name changes
        self.param.watch(self._on_asset_change, 'asset_name')
    
    def _parse_asset_names(self):
        """Parse asset_name as comma-separated list and remove duplicates"""
        if not self.asset_name:
            return []
        # Remove duplicates while preserving order
        seen = set()
        unique_names = []
        for name in self.asset_name.split(','):
            name = name.strip()
            if name and name not in seen:
                seen.add(name)
                unique_names.append(name)
        return unique_names
    
    def _fetch_records(self):
        """Fetch the metadata records for all asset names"""
        asset_names = self._parse_asset_names()
        if not asset_names:
            return []
        
        all_records = []
        for name in asset_names:
            records = self.client.retrieve_docdb_records(
                filter_query={'name': name},
            )
            if records:
                all_records.extend(records)
        
        return all_records
    
    def _on_asset_change(self, event):
        """Handle asset name changes from URL"""
        # Refetch records and update UI
        self.records = self._fetch_records()
        self.authors = self._extract_authors()
        self.contributions_df = self._initialize_contributions()
        
        # Update UI components
        asset_names = self._parse_asset_names()
        self.info.object = f"""
        **Assets loaded**: {len(self.records)} ({len(asset_names)} requested)  
        **Authors found**: {len(self.authors)}
        """
        self.table.value = self.contributions_df
    
    def _extract_authors(self):
        """Extract author names from all relevant sections of the metadata"""
        authors = []
        
        if not self.records:
            return authors
        
        def add_name(name):
            """Helper to add unique, non-generic names"""
            if name and name not in authors and name.lower() not in ['unknown', 'na', 'n/a', '']:
                authors.append(name)
        
        # Process all records
        for record in self.records:
            # 1. Data Description - Investigators
            data_desc = record.get('data_description', {})
# Process all records
        for record in self.records:
            # 1. Data Description - Investigators
            data_desc = record.get('data_description', {})
            investigators = data_desc.get('investigators', [])
            for inv in investigators:
                if isinstance(inv, dict):
                    add_name(inv.get('name'))
                elif isinstance(inv, str):
                    add_name(inv)
            
            # 2. Data Description - Fundees from funding_source
            funding_sources = data_desc.get('funding_source', [])
            for funding in funding_sources:
                fundee = funding.get('fundee', [])
                # In v2, fundee can be a list of Person objects
                if isinstance(fundee, list):
                    for person in fundee:
                        if isinstance(person, dict):
                            add_name(person.get('name'))
                        elif isinstance(person, str):
                            add_name(person)
                elif isinstance(fundee, str):
                    # Handle old format or string format
                    for name in fundee.replace(' and ', ',').split(','):
                        add_name(name.strip())
            
            # 3. Acquisition - Experimenters
            acquisition = record.get('acquisition', {})
            experimenters = acquisition.get('experimenters', [])
            for exp in experimenters:
                if isinstance(exp, dict):
                    add_name(exp.get('name'))
                elif isinstance(exp, str):
                    add_name(exp)
            
            # 4. Procedures - Experimenters (surgeons, etc.)
            procedures = record.get('procedures', {})
            subject_procedures = procedures.get('subject_procedures', [])
            for proc in subject_procedures:
                proc_experimenters = proc.get('experimenters', [])
                for exp in proc_experimenters:
                    if isinstance(exp, dict):
                        add_name(exp.get('name'))
                    elif isinstance(exp, str):
                        add_name(exp)
            
            specimen_procedures = procedures.get('specimen_procedures', [])
            for proc in specimen_procedures:
                proc_experimenters = proc.get('experimenters', [])
                for exp in proc_experimenters:
                    if isinstance(exp, dict):
                        add_name(exp.get('name'))
                    elif isinstance(exp, str):
                        add_name(exp)
            
            # 5. Processing - Experimenters (data processors)
            processing = record.get('processing', {})
            data_processes = processing.get('data_processes', [])
            for process in data_processes:
                proc_experimenters = process.get('experimenters', [])
                for exp in proc_experimenters:
                    if isinstance(exp, dict):
                        add_name(exp.get('name'))
                    elif isinstance(exp, str):
                        add_name(exp)
        
        return authors
    
    def _initialize_contributions(self):
        """Initialize the contributions dataframe"""
        data = {
            'Order': list(range(1, len(self.authors) + 1)),
            'Author': self.authors,
            'Shared First Author': [False] * len(self.authors),
        }
        
        # Add columns for each CReDIT category
        for category in CREDIT_CATEGORIES:
            data[category] = ['None'] * len(self.authors)
        
        return pd.DataFrame(data)
    
    def _create_ui(self):
        """Create the Panel UI"""
        # Title
        self.title = pn.pane.Markdown("## Author Contribution Matrix")
        
        # Asset name input
        self.asset_input = pn.widgets.TextInput(
            name='Asset Names (comma-separated)',
            value=self.asset_name,
            placeholder='Enter asset names separated by commas',
            sizing_mode='stretch_width',
        )
        self.asset_input.param.watch(self._on_asset_input, 'value')
        
        # Info about the records
        asset_names = self._parse_asset_names()
        self.info = pn.pane.Markdown(f"""
        **Assets loaded**: {len(self.records)} ({len(asset_names)} requested)  
        **Authors found**: {len(self.authors)}
        """)
        
        # Define cell styling function
        def style_contribution_cell(value):
            """Return CSS string for a contribution cell based on its value"""
            if value == 'High':
                return 'background-color: #6633aa; color: white'
            elif value == 'Low':
                return 'background-color: #d4b5f0; color: #333333'
            else:  # None
                return 'background-color: #ffffff; color: #333333'
        
        # Create the editable table with cell styling
        editors = {
            'Order': {'type': 'number', 'min': 1},
            'Shared First Author': {'type': 'tickCross'},
        }
        editors.update({
            category: {'type': 'list', 'values': list(CONTRIBUTION_LEVELS.keys())}
            for category in CREDIT_CATEGORIES
        })
        
        # Set column widths
        widths = {
            'Order': 60,
            'Author': 150,
            'Shared First Author': 80,
        }
        
        self.table = pn.widgets.Tabulator(
            self.contributions_df,
            editors=editors,
            widths=widths,
            show_index=False,
            layout='fit_columns',
            height=400,
            sizing_mode='stretch_width',
            text_align='center',
        )
        
        # Apply styling using pandas .style.map()
        self.table.style.map(style_contribution_cell, subset=CREDIT_CATEGORIES)
        
        # Download button
        self.download_button = pn.widgets.Button(
            name="Generate LaTeX",
            button_type="primary",
            width=150,
        )
        self.download_button.on_click(self._generate_latex)
        
        # Output area
        self.output = pn.pane.Markdown("")
        
        # Create main container with styling
        content = pn.Column(
            self.title,
            self.asset_input,
            self.info,
            self.table,
            self.download_button,
            self.output,
            styles=OUTER_STYLE,
        )
        
        # Layout with HSpacers to center at 90% width
        self.layout = pn.Row(
            pn.HSpacer(),
            pn.Column(content, width=int(1400 * 0.9)),
            pn.HSpacer(),
        )
    
    def _on_asset_input(self, event):
        """Handle manual asset name input"""
        self.asset_name = event.new
    
    def _generate_latex_columns(self, df):
        """Generate LaTeX for column labels (authors)"""
        lines = []
        lines.append("    % column labels")
        lines.append("    \\foreach \\a [count=\\n] in {")
        
        for _, row in df.iterrows():
            author = row['Author']
            is_first = row['Shared First Author']
            
            # Format author name (e.g., "Cindy Poo" -> "C. Poo")
            parts = author.split()
            if len(parts) >= 2:
                formatted = f"{parts[0][0]}. {' '.join(parts[1:])}"
            else:
                formatted = author
            
            # Add marker for shared first authors
            if is_first:
                formatted += "*"
            
            lines.append(f"        {formatted},")
        
        lines.append("    } {")
        lines.append("        \\node[col header] at (\\n,0) {\\a};")
        lines.append("    }")
        
        return "\n".join(lines)
    
    def _generate_latex_rows(self):
        """Generate LaTeX for row labels (CReDIT categories)"""
        lines = []
        lines.append("    % row labels")
        lines.append("    \\foreach \\a [count=\\i] in {")
        
        for category in CREDIT_CATEGORIES:
            lines.append(f"        {category},")
        
        lines.append("    } {")
        lines.append("        \\node[row label] at (0,-\\i) {\\a};")
        lines.append("    }")
        
        return "\n".join(lines)
    
    def _generate_latex_heatmap(self, df):
        """Generate LaTeX for the contribution heatmap"""
        lines = []
        lines.append("    \\foreach \\y [count=\\n] in {")
        
        for category in CREDIT_CATEGORIES:
            values = []
            for author in df['Author']:
                # Get the contribution level for this author and category
                row = df[df['Author'] == author]
                level = row[category].values[0] if len(row) > 0 else "None"
                values.append(CONTRIBUTION_LEVELS[level])
            
            lines.append("        {" + ",".join(str(v) for v in values) + "},")
        
        lines.append("    } {")
        lines.append("        % heatmap tiles")
        lines.append("        \\foreach \\x [count=\\m] in \\y {")
        lines.append("            \\node[fill=tilecolor!\\x!white, tile, text=white] (tile) at (\\m,-\\n) {};")
        lines.append("        }")
        lines.append("    }")
        
        return "\n".join(lines)
    
    def _generate_latex(self, event):
        """Generate LaTeX output"""
        # Get current data from table and sort by Order column
        df = self.table.value.sort_values('Order').reset_index(drop=True)
        
        # Build LaTeX output
        parts = []
        parts.append("\\section*{Author contribution matrix}")
        parts.append("\\begin{tikzpicture}[scale=0.6]")
        parts.append("")
        parts.append(self._generate_latex_columns(df))
        parts.append("")
        parts.append(self._generate_latex_rows())
        parts.append("")
        parts.append(self._generate_latex_heatmap(df))
        parts.append("")
        parts.append("    % description below heatmap ")
        parts.append("    \\node [legend line] at (1, 0 |- tile.south) {* these authors contributed equally};")
        parts.append("")
        parts.append("\\end{tikzpicture}")
        
        latex_output = "\n".join(parts)
        
        # Display output
        self.output.object = f"""### LaTeX Output

```latex
{latex_output}
```

Copy the LaTeX code above to use in your document.
"""
    
    def servable(self):
        """Return the servable layout"""
        return self.layout


# Create and serve the app
if __name__ == "__main__" or __name__.startswith("bokeh"):
    app = ContributionMatrix()
    app.servable().servable(title="Author Contributions")
