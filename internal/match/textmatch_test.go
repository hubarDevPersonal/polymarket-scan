package match

import (
	"testing"
)

func TestNormalizeTitle(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "mixed case",
			input:    "Will TRUMP Win 2024?",
			expected: "will trump win 2024",
		},
		{
			name:     "special characters",
			input:    "Biden's Election! (Yes/No)?",
			expected: "biden s election yes no",
		},
		{
			name:     "multiple spaces",
			input:    "Will   Trump    Win",
			expected: "will trump win",
		},
		{
			name:     "leading trailing spaces",
			input:    "  Trump Election  ",
			expected: "trump election",
		},
		{
			name:     "punctuation",
			input:    "Trump, Biden & Harris: Who wins?",
			expected: "trump biden harris who wins",
		},
		{
			name:     "numbers preserved",
			input:    "2024 Presidential Election",
			expected: "2024 presidential election",
		},
		{
			name:     "empty string",
			input:    "",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := NormalizeTitle(tt.input)
			if result != tt.expected {
				t.Errorf("NormalizeTitle(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestTokenize(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []string
	}{
		{
			name:     "basic tokenization",
			input:    "will trump win 2024",
			expected: []string{"will", "trump", "win", "2024"},
		},
		{
			name:     "empty string",
			input:    "",
			expected: []string{},
		},
		{
			name:     "single word",
			input:    "trump",
			expected: []string{"trump"},
		},
		{
			name:     "multiple spaces",
			input:    "trump  wins  election",
			expected: []string{"trump", "wins", "election"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := Tokenize(tt.input)
			if len(result) != len(tt.expected) {
				t.Fatalf("Tokenize(%q) returned %d tokens, want %d", tt.input, len(result), len(tt.expected))
			}
			for i := range result {
				if result[i] != tt.expected[i] {
					t.Errorf("Tokenize(%q)[%d] = %q, want %q", tt.input, i, result[i], tt.expected[i])
				}
			}
		})
	}
}

func TestJaccardSimilarity(t *testing.T) {
	tests := []struct {
		name     string
		tokens1  []string
		tokens2  []string
		expected float64
	}{
		{
			name:     "identical sets",
			tokens1:  []string{"trump", "wins", "2024"},
			tokens2:  []string{"trump", "wins", "2024"},
			expected: 1.0,
		},
		{
			name:     "identical sets different order",
			tokens1:  []string{"trump", "wins", "2024"},
			tokens2:  []string{"2024", "trump", "wins"},
			expected: 1.0,
		},
		{
			name:     "no overlap",
			tokens1:  []string{"trump", "wins"},
			tokens2:  []string{"biden", "loses"},
			expected: 0.0,
		},
		{
			name:     "partial overlap",
			tokens1:  []string{"trump", "wins", "election"},
			tokens2:  []string{"biden", "wins", "election"},
			expected: 0.5, // 2 shared / (3 + 3 - 2) = 2/4 = 0.5
		},
		{
			name:     "one empty set",
			tokens1:  []string{"trump"},
			tokens2:  []string{},
			expected: 0.0,
		},
		{
			name:     "both empty",
			tokens1:  []string{},
			tokens2:  []string{},
			expected: 1.0,
		},
		{
			name:     "subset relationship",
			tokens1:  []string{"trump", "wins"},
			tokens2:  []string{"trump", "wins", "2024", "election"},
			expected: 0.5, // 2 shared / (2 + 4 - 2) = 2/4 = 0.5
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := JaccardSimilarity(tt.tokens1, tt.tokens2)
			if result != tt.expected {
				t.Errorf("JaccardSimilarity(%v, %v) = %.2f, want %.2f",
					tt.tokens1, tt.tokens2, result, tt.expected)
			}
		})
	}
}

func TestTitleSimilarity(t *testing.T) {
	tests := []struct {
		name      string
		title1    string
		title2    string
		minSim    float64
		expectGTE bool
	}{
		{
			name:      "exact match",
			title1:    "Will Trump Win 2024?",
			title2:    "Will Trump Win 2024?",
			minSim:    1.0,
			expectGTE: true,
		},
		{
			name:      "similar titles",
			title1:    "Trump Wins Presidential Election 2024",
			title2:    "Trump Presidential Election 2024",
			minSim:    0.75,
			expectGTE: true,
		},
		{
			name:      "different titles",
			title1:    "Trump Wins 2024",
			title2:    "Biden Loses 2024",
			minSim:    0.5,
			expectGTE: false,
		},
		{
			name:      "case insensitive",
			title1:    "TRUMP WINS",
			title2:    "trump wins",
			minSim:    1.0,
			expectGTE: true,
		},
		{
			name:      "punctuation ignored",
			title1:    "Will Trump Win? (Yes/No)",
			title2:    "Will Trump Win Yes No",
			minSim:    1.0,
			expectGTE: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := TitleSimilarity(tt.title1, tt.title2)
			if tt.expectGTE {
				if result < tt.minSim {
					t.Errorf("TitleSimilarity(%q, %q) = %.2f, want >= %.2f",
						tt.title1, tt.title2, result, tt.minSim)
				}
			} else {
				if result >= tt.minSim {
					t.Errorf("TitleSimilarity(%q, %q) = %.2f, want < %.2f",
						tt.title1, tt.title2, result, tt.minSim)
				}
			}
		})
	}
}

func TestIsLikelyMatch(t *testing.T) {
	tests := []struct {
		name      string
		title1    string
		title2    string
		threshold float64
		expected  bool
	}{
		{
			name:      "match above threshold",
			title1:    "Trump Wins 2024 Presidential Election",
			title2:    "Trump Presidential Election 2024",
			threshold: 0.60,
			expected:  true,
		},
		{
			name:      "match below threshold",
			title1:    "Trump Wins",
			title2:    "Biden Loses",
			threshold: 0.60,
			expected:  false,
		},
		{
			name:      "exact match",
			title1:    "Election 2024",
			title2:    "Election 2024",
			threshold: 0.95,
			expected:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := IsLikelyMatch(tt.title1, tt.title2, tt.threshold)
			if result != tt.expected {
				sim := TitleSimilarity(tt.title1, tt.title2)
				t.Errorf("IsLikelyMatch(%q, %q, %.2f) = %v, want %v (similarity: %.2f)",
					tt.title1, tt.title2, tt.threshold, result, tt.expected, sim)
			}
		})
	}
}

func TestRemoveStopWords(t *testing.T) {
	tests := []struct {
		name     string
		input    []string
		expected []string
	}{
		{
			name:     "with stop words",
			input:    []string{"the", "trump", "will", "win", "the", "election"},
			expected: []string{"trump", "win", "election"},
		},
		{
			name:     "no stop words",
			input:    []string{"trump", "election", "2024"},
			expected: []string{"trump", "election", "2024"},
		},
		{
			name:     "all stop words",
			input:    []string{"the", "a", "an", "and"},
			expected: []string{},
		},
		{
			name:     "empty",
			input:    []string{},
			expected: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := RemoveStopWords(tt.input)
			if len(result) != len(tt.expected) {
				t.Fatalf("RemoveStopWords(%v) returned %d tokens, want %d",
					tt.input, len(result), len(tt.expected))
			}
			for i := range result {
				if result[i] != tt.expected[i] {
					t.Errorf("RemoveStopWords(%v)[%d] = %q, want %q",
						tt.input, i, result[i], tt.expected[i])
				}
			}
		})
	}
}

func BenchmarkTitleSimilarity(b *testing.B) {
	title1 := "Will Trump Win the 2024 Presidential Election?"
	title2 := "Trump Presidential Election 2024 Victory"

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		TitleSimilarity(title1, title2)
	}
}

func BenchmarkNormalizeTitle(b *testing.B) {
	title := "Will Trump Win the 2024 Presidential Election?"

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		NormalizeTitle(title)
	}
}
