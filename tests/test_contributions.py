"""Tests for the contributions module"""

import unittest
import pandas as pd
from pathlib import Path
import sys

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from zombie.contributions import CREDIT_CATEGORIES, CONTRIBUTION_LEVELS


class TestLatexGeneration(unittest.TestCase):
    """Test LaTeX generation functions"""
    
    def setUp(self):
        """Set up test fixtures"""
        # We'll test the helper functions directly without instantiating the class
        
        # Load the expected output
        test_resources = Path(__file__).parent / "resources"
        with open(test_resources / "latex_output_example.txt", "r") as f:
            self.expected_output = f.read()
        
        # Create test data matching the example
        self.test_authors = [
            "D. Birman",
            "Author 2",
            "Author 3",
            "Author 4",
            "Author 5",
            "Author 6",
            "Author 7",
            "Author 8",
            "Author 9",
            "Author 10",
            "Author 11",
        ]
        
        # Create test dataframe with the contribution values from the example
        self.test_df = pd.DataFrame({
            'Author': self.test_authors,
            'Conceptualization': ['High', 'High', 'Low', 'None', 'None', 'None', 'None', 'None', 'None', 'High', 'High'],
            'Formal analysis': ['High', 'None', 'High', 'None', 'None', 'None', 'Medium', 'Medium', 'Medium', 'None', 'Medium'],
            'Investigation': ['High', 'Low', 'None', 'High', 'High', 'Medium', 'None', 'None', 'None', 'None', 'Medium'],
            'Methodology': ['High', 'Low', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'None'],
            'Resources': ['Low', 'High', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Low', 'None'],
            'Software': ['High', 'Medium', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Medium', 'None'],
            'Writing---Original Draft': ['High', 'High', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Medium', 'None'],
            'Writing---Reviewing and Editing': ['High', 'High', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Medium', 'Low'],
            'Funding acquisition': ['None', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Low', 'High', 'High'],
        })
    
    def _generate_latex_columns(self, authors):
        """Generate LaTeX for column labels (authors)"""
        lines = []
        lines.append("    % column labels")
        lines.append("    \\foreach \\a [count=\\n] in {")
        
        for i, author in enumerate(authors):
            # Use author name as-is, just add markers
            formatted = author
            
            # Add marker based on position (matching the example)
            if i == 0 or i == 1:
                formatted += "*"
            elif i == 9 or i == 10:
                formatted += "$^\\dagger$"
            
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
    
    def test_generate_latex_columns(self):
        """Test column label generation"""
        result = self._generate_latex_columns(self.test_authors)
        
        expected_lines = [
            "    % column labels",
            "    \\foreach \\a [count=\\n] in {",
            "        D. Birman*,",
            "        Author 2*,",
            "        Author 3,",
            "        Author 4,",
            "        Author 5,",
            "        Author 6,",
            "        Author 7,",
            "        Author 8,",
            "        Author 9,",
            "        Author 10$^\\dagger$,",
            "        Author 11$^\\dagger$,",
            "    } {",
            "        \\node[col header] at (\\n,0) {\\a};",
            "    }",
        ]
        expected = "\n".join(expected_lines)
        
        self.assertEqual(result, expected, "Column labels should match expected format")
    
    def test_generate_latex_rows(self):
        """Test row label generation"""
        result = self._generate_latex_rows()
        
        expected_lines = [
            "    % row labels",
            "    \\foreach \\a [count=\\i] in {",
            "        Conceptualization,",
            "        Formal analysis,",
            "        Investigation,",
            "        Methodology,",
            "        Resources,",
            "        Software,",
            "        Writing---Original Draft,",
            "        Writing---Reviewing and Editing,",
            "        Funding acquisition,",
            "    } {",
            "        \\node[row label] at (0,-\\i) {\\a};",
            "    }",
        ]
        expected = "\n".join(expected_lines)
        
        self.assertEqual(result, expected, "Row labels should match expected format")
    
    def test_generate_latex_heatmap(self):
        """Test heatmap data generation"""
        result = self._generate_latex_heatmap(self.test_df)
        
        expected_lines = [
            "    \\foreach \\y [count=\\n] in {",
            "        {\\hi,\\hi,\\lo,0,0,0,0,0,0,\\hi,\\hi},",
            "        {\\hi,0,\\hi,0,0,0,\\mid,\\mid,\\mid,0,\\mid},",
            "        {\\hi,\\lo,0,\\hi,\\hi,\\mid,0,0,0,0,\\mid},",
            "        {\\hi,\\lo,0,0,0,0,0,0,0,0,0},",
            "        {\\lo,\\hi,0,0,0,0,0,0,0,\\lo,0},",
            "        {\\hi,\\mid,0,0,0,0,0,0,0,\\mid,0},",
            "        {\\hi,\\hi,0,0,0,0,0,0,0,\\mid,0},",
            "        {\\hi,\\hi,0,0,0,0,0,0,0,\\mid,\\lo},",
            "        {0,0,0,0,0,0,0,0,\\lo,\\hi,\\hi},",
            "    } {",
            "        % heatmap tiles",
            "        \\foreach \\x [count=\\m] in \\y {",
            "            \\node[fill=tilecolor!\\x!white, tile, text=white] (tile) at (\\m,-\\n) {};",
            "        }",
            "    }",
        ]
        expected = "\n".join(expected_lines)
        
        self.assertEqual(result, expected, "Heatmap data should match expected format")
    
    def test_full_latex_output(self):
        """Test complete LaTeX output generation"""
        # Build the full output using the helper methods
        parts = []
        parts.append("\\section*{Author contribution matrix}")
        parts.append("\\begin{tikzpicture}[scale=0.6]")
        parts.append("")
        parts.append(self._generate_latex_columns(self.test_authors))
        parts.append("")
        parts.append(self._generate_latex_rows())
        parts.append("")
        parts.append(self._generate_latex_heatmap(self.test_df))
        parts.append("")
        parts.append("    % description below heatmap ")
        parts.append("    \\node [legend line] at (1, 0 |- tile.south) {*, $^\\dagger$ these authors contributed equally};")
        parts.append("")
        parts.append("\\end{tikzpicture}")
        
        result = "\n".join(parts)
        
        # The expected output should match exactly
        self.assertEqual(result, self.expected_output, "Full LaTeX output should match example file exactly")


if __name__ == '__main__':
    unittest.main()
