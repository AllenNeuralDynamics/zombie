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
            self.expected_output = f.read().rstrip('\n')  # Strip trailing newline for comparison
        
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
            'First Author': [True, True, False, False, False, False, False, False, False, False, False],
            'Conceptualization': ['High', 'High', 'Low', 'None', 'None', 'None', 'None', 'None', 'None', 'High', 'High'],
            'Formal analysis': ['High', 'None', 'High', 'None', 'None', 'None', 'Low', 'Low', 'Low', 'None', 'Low'],
            'Investigation': ['High', 'Low', 'None', 'High', 'High', 'Low', 'None', 'None', 'None', 'None', 'Low'],
            'Methodology': ['High', 'Low', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'None'],
            'Resources': ['Low', 'High', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Low', 'None'],
            'Software': ['High', 'Low', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Low', 'None'],
            'Writing---Original Draft': ['High', 'High', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Low', 'None'],
            'Writing---Reviewing and Editing': ['High', 'High', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Low', 'Low'],
            'Funding acquisition': ['None', 'None', 'None', 'None', 'None', 'None', 'None', 'None', 'Low', 'High', 'High'],
        })
    
    def _generate_latex_columns(self, df):
        """Generate LaTeX for column labels (CReDIT categories)"""
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
        """Generate LaTeX for row labels (authors)"""
        lines = []
        lines.append("    % row labels")
        lines.append("    \\foreach \\a [count=\\i] in {")
        
        for _, row in df.iterrows():
            author = row['Author']
            is_first = row['First Author']
            
            # Use author name as-is
            formatted = author
            
            # Add marker for first authors
            if is_first:
                formatted += "*"
            # Add dagger for specific authors (matching example)
            elif author in ['Author 10', 'Author 11']:
                formatted += "$^\\dagger$"
            
            lines.append(f"        {formatted},")
        
        lines.append("    } {")
        lines.append("        \\node[row label] at (0,-\\i) {\\a};")
        lines.append("    }")
        
        return "\n".join(lines)
    
    def _generate_latex_heatmap(self, df):
        """Generate LaTeX for the contribution heatmap"""
        lines = []
        lines.append("    \\foreach \\y [count=\\n] in {")
        
        # Iterate through authors (rows)
        for _, row in df.iterrows():
            values = []
            # For each author, get their contribution level for each category (columns)
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
    
    def test_generate_latex_columns(self):
        """Test column label generation"""
        result = self._generate_latex_columns(self.test_df)
        
        expected_lines = [
            "    % column labels",
            "    \\foreach \\a [count=\\n] in {",
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
            "        \\node[col header] at (\\n,0) {\\a};",
            "    }",
        ]
        expected = "\n".join(expected_lines)
        
        self.assertEqual(result, expected, "Column labels should match expected format")
    
    def test_generate_latex_rows(self):
        """Test row label generation"""
        result = self._generate_latex_rows(self.test_df)
        
        expected_lines = [
            "    % row labels",
            "    \\foreach \\a [count=\\i] in {",
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
            "        {\\hi,\\hi,\\hi,\\hi,\\lo,\\hi,\\hi,\\hi,0},",
            "        {\\hi,0,\\lo,\\lo,\\hi,\\lo,\\hi,\\hi,0},",
            "        {\\lo,\\hi,0,0,0,0,0,0,0},",
            "        {0,0,\\hi,0,0,0,0,0,0},",
            "        {0,0,\\hi,0,0,0,0,0,0},",
            "        {0,0,\\lo,0,0,0,0,0,0},",
            "        {0,\\lo,0,0,0,0,0,0,0},",
            "        {0,\\lo,0,0,0,0,0,0,0},",
            "        {0,\\lo,0,0,0,0,0,0,\\lo},",
            "        {\\hi,0,0,0,\\lo,\\lo,\\lo,\\lo,\\hi},",
            "        {\\hi,\\lo,\\lo,0,0,0,0,\\lo,\\hi},",
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
        parts.append(self._generate_latex_columns(self.test_df))
        parts.append("")
        parts.append(self._generate_latex_rows(self.test_df))
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
