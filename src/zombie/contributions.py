"""Author Contribution Matrix Panel App

This app allows users to specify author contributions using the CReDIT taxonomy
and generate LaTeX output for publication.
"""

import panel as pn
import pandas as pd
import param
from panel.custom import PyComponent
from aind_data_access_api.document_db import MetadataDbClient
from zombie.layout import OUTER_STYLE, format_css_background

pn.extension("tabulator")
format_css_background()

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

CONTRIBUTION_LEVELS = {
    "None": 0,
    "Low": "\\lo",
    "High": "\\hi",
}


class AuthorOrderComponent(PyComponent):

    def __init__(self, parent, **kwargs):
        super().__init__(**kwargs)
        self.parent = parent
        self.parent.param.watch(self._on_df_change, "contributions_df")

        self.author_order = pn.widgets.MultiSelect(
            name="Author Order",
            value=[],
            options=[],
            size=10,
            width=200,
        )

        self.move_up_btn = pn.widgets.Button(name="↑ Move Up", button_type="default", width=100)
        self.move_down_btn = pn.widgets.Button(name="↓ Move Down", button_type="default", width=100)
        self.move_up_btn.on_click(self._move_author_up)
        self.move_down_btn.on_click(self._move_author_down)

        self.panel = pn.Column(
            self.author_order,
            pn.Row(self.move_up_btn, self.move_down_btn),
            width=250,
        )

    def _on_df_change(self, event):
        if event.new is not None and not event.new.empty:
            authors = event.new["Author"].tolist()
            self.author_order.options = authors
            if self.author_order.size != min(len(authors), 10):
                self.author_order.size = min(len(authors), 10)

    def _move_author_up(self, event):
        if not self.author_order.value or len(self.author_order.value) != 1:
            return

        author = self.author_order.value[0]
        current_options = list(self.author_order.options)
        idx = current_options.index(author)

        if idx > 0:
            current_options[idx], current_options[idx - 1] = current_options[idx - 1], current_options[idx]
            self.author_order.options = current_options
            self._update_df_order(current_options)

    def _move_author_down(self, event):
        if not self.author_order.value or len(self.author_order.value) != 1:
            return

        author = self.author_order.value[0]
        current_options = list(self.author_order.options)
        idx = current_options.index(author)

        if idx < len(current_options) - 1:
            current_options[idx], current_options[idx + 1] = current_options[idx + 1], current_options[idx]
            self.author_order.options = current_options
            self._update_df_order(current_options)

    def _update_df_order(self, new_order):
        if self.parent.contributions_df is None or self.parent.contributions_df.empty:
            return

        order_map = {author: i for i, author in enumerate(new_order)}
        df = self.parent.contributions_df.copy()
        df["_order"] = df["Author"].map(order_map)
        df = df.sort_values("_order").drop("_order", axis=1).reset_index(drop=True)
        self.parent.contributions_df = df

    def __panel__(self):
        return self.panel


class AuthorManagementComponent(PyComponent):

    def __init__(self, parent, **kwargs):
        super().__init__(**kwargs)
        self.parent = parent

        self.new_author_input = pn.widgets.TextInput(
            name="Add author",
            placeholder="Enter author name",
            width=200,
        )

        self.add_author_btn = pn.widgets.Button(
            name="Add Author",
            button_type="primary",
            width=100,
        )
        self.add_author_btn.on_click(self._add_author)

        self.remove_author_select = pn.widgets.Select(
            name="Remove Author",
            options=[],
            width=200,
        )

        self.remove_author_btn = pn.widgets.Button(
            name="Remove Author",
            button_type="danger",
            width=100,
        )
        self.remove_author_btn.on_click(self._remove_author)

        self.parent.param.watch(self._on_df_change, "contributions_df")

        self.panel = pn.Column(
            self.new_author_input,
            self.add_author_btn,
            self.remove_author_select,
            self.remove_author_btn,
            width=250,
        )

    def _on_df_change(self, event):
        if event.new is not None and not event.new.empty:
            authors = event.new["Author"].tolist()
            self.remove_author_select.options = authors

    def _add_author(self, event):
        new_author = self.new_author_input.value.strip()
        if not new_author:
            return

        df = self.parent.contributions_df
        if new_author in df["Author"].values:
            return

        new_row = {"Author": new_author, "First Author": False}
        for category in CREDIT_CATEGORIES:
            new_row[category] = "None"

        new_df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
        self.parent.contributions_df = new_df
        self.new_author_input.value = ""

    def _remove_author(self, event):
        author_to_remove = self.remove_author_select.value
        if not author_to_remove:
            return

        df = self.parent.contributions_df
        new_df = df[df["Author"] != author_to_remove].reset_index(drop=True)
        self.parent.contributions_df = new_df

    def __panel__(self):
        return self.panel


class ContributionTableComponent(PyComponent):

    def __init__(self, parent, **kwargs):
        super().__init__(**kwargs)
        self.parent = parent
        self.parent.param.watch(self._on_df_change, "contributions_df")

        def style_contribution_cell(value):
            if value == "High":
                return "background-color: #6633aa; color: white"
            elif value == "Low":
                return "background-color: #d4b5f0; color: #333333"
            else:
                return "background-color: #ffffff; color: #333333"

        editors = {"First Author": {"type": "tickCross"}}
        editors.update(
            {category: {"type": "list", "values": list(CONTRIBUTION_LEVELS.keys())} for category in CREDIT_CATEGORIES}
        )

        self.table = pn.widgets.Tabulator(
            pd.DataFrame(),
            editors=editors,
            show_index=False,
            layout="fit_columns",
            height=400,
            sizing_mode="stretch_width",
            text_align="center",
            sortable=False,
        )
        self.table.style.map(style_contribution_cell, subset=CREDIT_CATEGORIES)

        self.table.param.watch(self._on_table_edit, "value")

        self.panel = pn.Column(self.table, sizing_mode="stretch_width")

    def _on_df_change(self, event):
        if event.new is not None:
            self.table.value = event.new

    def _on_table_edit(self, event):
        if event.new is not None and not event.new.equals(self.parent.contributions_df):
            self.parent.contributions_df = event.new

    def __panel__(self):
        return self.panel


class LaTeXOutputComponent(PyComponent):

    def __init__(self, parent, **kwargs):
        super().__init__(**kwargs)
        self.parent = parent

        self.download_button = pn.widgets.Button(
            name="Generate LaTeX",
            button_type="primary",
            width=150,
        )
        self.download_button.on_click(self._generate_latex)

        self.output = pn.pane.Markdown("")

        self.panel = pn.Column(
            self.download_button,
            self.output,
        )

    def _generate_latex_columns(self, df):
        lines = []
        lines.append("    % column labels")
        lines.append("    \\foreach \\a [count=\\n] in {")

        for category in CREDIT_CATEGORIES:
            lines.append(f"        {category},")

        lines.append("    } {")
        lines.append("        \\node[col header] at (\\n,0) {\\a};")
        lines.append("    }")

        return "\n".join(lines)

    def _generate_latex_rows(self, df):
        lines = []
        lines.append("    % row labels")
        lines.append("    \\foreach \\a [count=\\i] in {")

        for _, row in df.iterrows():
            author = row["Author"]
            is_first = row["First Author"]

            parts = author.split()
            if len(parts) >= 2:
                formatted = f"{parts[0][0]}. {' '.join(parts[1:])}"
            else:
                formatted = author

            if is_first:
                formatted += "*"

            lines.append(f"        {formatted},")

        lines.append("    } {")
        lines.append("        \\node[row label] at (0,-\\i) {\\a};")
        lines.append("    }")

        return "\n".join(lines)

    def _generate_latex_heatmap(self, df):
        lines = []
        lines.append("    \\foreach \\y [count=\\n] in {")

        for _, row in df.iterrows():
            values = []
            for category in CREDIT_CATEGORIES:
                level = row[category]
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
        if self.parent.contributions_df is None or self.parent.contributions_df.empty:
            self.output.object = "No contribution data available."
            return

        df = self.parent.contributions_df

        parts = []
        parts.append("\\section*{Author contribution matrix}")
        parts.append("\\begin{tikzpicture}[scale=0.6]")
        parts.append("")
        parts.append(self._generate_latex_columns(df))
        parts.append("")
        parts.append(self._generate_latex_rows(df))
        parts.append("")
        parts.append(self._generate_latex_heatmap(df))
        parts.append("")
        parts.append("    % description below heatmap ")
        parts.append("    \\node [legend line] at (1, 0 |- tile.south) {* these authors contributed equally};")
        parts.append("")
        parts.append("\\end{tikzpicture}")

        latex_output = "\n".join(parts)

        self.output.object = f"""### LaTeX Output

```latex
{latex_output}
```

Copy the LaTeX code above to use in your document.
"""

    def __panel__(self):
        return self.panel


class ContributionMatrix(param.Parameterized):
    asset_name = param.String(default="multiplane-ophys_804670_2025-09-17_10-26-00_processed_2025-09-18_18-01-45")
    contributions_df = param.DataFrame()

    def __init__(self, **params):
        super().__init__(**params)

        self.client = MetadataDbClient(
            host="api.allenneuraldynamics.org",
            version="v2",
        )

        pn.state.location.sync(self, {"asset_name": "asset_name"})

        self.records = self._fetch_records()
        self.authors, self.author_sources = self._extract_authors()

        self._create_ui()

        self.contributions_df = self._initialize_contributions()

        self.param.watch(self._on_asset_change, "asset_name")

    def _parse_asset_names(self):
        if not self.asset_name:
            return []
        seen = set()
        unique_names = []
        for name in self.asset_name.split(","):
            name = name.strip()
            if name and name not in seen:
                seen.add(name)
                unique_names.append(name)
        return unique_names

    def _fetch_records(self):
        asset_names = self._parse_asset_names()
        if not asset_names:
            return []

        all_records = []
        for name in asset_names:
            records = self.client.retrieve_docdb_records(
                filter_query={"name": name},
            )
            if records:
                all_records.extend(records)

        return all_records

    def _on_asset_change(self, event):
        self.records = self._fetch_records()
        self.authors, self.author_sources = self._extract_authors()
        self.contributions_df = self._initialize_contributions()

        asset_names = self._parse_asset_names()
        author_details = "\n".join(
            [f"  - **{author}**: {', '.join(self.author_sources[author])}" for author in self.authors]
        )
        self.info.object = f"""
**Assets loaded**: {len(self.records)} ({len(asset_names)} requested)
**Authors found**: {len(self.authors)}

{author_details}
"""

    def _extract_authors(self):
        authors = []
        author_sources = {}

        if not self.records:
            return authors, author_sources

        def add_name(name, source):
            if name and name.lower() not in ["unknown", "na", "n/a", ""]:
                if name not in authors:
                    authors.append(name)
                    author_sources[name] = []
                if source not in author_sources[name]:
                    author_sources[name].append(source)

        for record in self.records:
            data_desc = record.get("data_description", {})
            investigators = data_desc.get("investigators", [])
            for inv in investigators:
                if isinstance(inv, dict):
                    add_name(inv.get("name"), "investigators")
                elif isinstance(inv, str):
                    add_name(inv, "investigators")

            funding_sources = data_desc.get("funding_source", [])
            for funding in funding_sources:
                fundee = funding.get("fundee", [])
                if isinstance(fundee, list):
                    for person in fundee:
                        if isinstance(person, dict):
                            add_name(person.get("name"), "funding")
                        elif isinstance(person, str):
                            add_name(person, "funding")
                elif isinstance(fundee, str):
                    for name in fundee.replace(" and ", ",").split(","):
                        add_name(name.strip(), "funding")

            acquisition = record.get("acquisition", {})
            experimenters = acquisition.get("experimenters", [])
            for exp in experimenters:
                if isinstance(exp, dict):
                    add_name(exp.get("name"), "acquisition")
                elif isinstance(exp, str):
                    add_name(exp, "acquisition")

            procedures = record.get("procedures", {})
            subject_procedures = procedures.get("subject_procedures", [])
            for proc in subject_procedures:
                proc_experimenters = proc.get("experimenters", [])
                for exp in proc_experimenters:
                    if isinstance(exp, dict):
                        add_name(exp.get("name"), "procedures")
                    elif isinstance(exp, str):
                        add_name(exp, "procedures")

            specimen_procedures = procedures.get("specimen_procedures", [])
            for proc in specimen_procedures:
                proc_experimenters = proc.get("experimenters", [])
                for exp in proc_experimenters:
                    if isinstance(exp, dict):
                        add_name(exp.get("name"), "procedures")
                    elif isinstance(exp, str):
                        add_name(exp, "procedures")

            processing = record.get("processing", {})
            data_processes = processing.get("data_processes", [])
            for process in data_processes:
                proc_experimenters = process.get("experimenters", [])
                for exp in proc_experimenters:
                    if isinstance(exp, dict):
                        add_name(exp.get("name"), "processing")
                    elif isinstance(exp, str):
                        add_name(exp, "processing")

        return authors, author_sources

    def _initialize_contributions(self):
        data = {
            "Author": self.authors,
            "First Author": [False] * len(self.authors),
        }

        for category in CREDIT_CATEGORIES:
            data[category] = ["None"] * len(self.authors)

        return pd.DataFrame(data)

    def _create_ui(self):
        self.title = pn.pane.Markdown("## Author Contribution Matrix")

        self.asset_input = pn.widgets.TextInput(
            name="Asset Names (comma-separated)",
            value=self.asset_name,
            placeholder="Enter asset names separated by commas",
            sizing_mode="stretch_width",
        )
        self.asset_input.param.watch(self._on_asset_input, "value")

        asset_names = self._parse_asset_names()
        author_details = "\n".join(
            [f"  - **{author}**: {', '.join(self.author_sources[author])}" for author in self.authors]
        )
        self.info = pn.pane.Markdown(
            f"""
**Assets loaded**: {len(self.records)} ({len(asset_names)} requested)
**Authors found**: {len(self.authors)}

{author_details}
        """
        )

        self.author_order_component = AuthorOrderComponent(parent=self)
        self.author_management_component = AuthorManagementComponent(parent=self)
        self.table_component = ContributionTableComponent(parent=self)
        self.latex_component = LaTeXOutputComponent(parent=self)

        content = pn.Column(
            self.title,
            self.asset_input,
            pn.Row(
                self.info,
                pn.HSpacer(),
                self.author_order_component,
                self.author_management_component,
            ),
            self.table_component,
            self.latex_component,
            styles=OUTER_STYLE,
        )

        self.layout = pn.Row(
            pn.HSpacer(),
            pn.Column(content, width=1600),
            pn.HSpacer(),
        )

    def _on_asset_input(self, event):
        self.asset_name = event.new

    def servable(self):
        return self.layout


if __name__ == "__main__" or __name__.startswith("bokeh"):
    app = ContributionMatrix()
    app.servable().servable(title="Author Contributions")
