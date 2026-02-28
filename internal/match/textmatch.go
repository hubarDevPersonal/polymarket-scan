package match

import (
	"regexp"
	"strings"
	"unicode"
)

var (
	nonAlphanumeric = regexp.MustCompile(`[^a-z0-9\s]+`)
	multiSpace      = regexp.MustCompile(`\s+`)
)

// NormalizeTitle converts a title to lowercase, removes special characters,
// and normalizes whitespace for consistent comparison.
func NormalizeTitle(title string) string {
	// Convert to lowercase
	s := strings.ToLower(title)
	// Remove non-alphanumeric except spaces
	s = nonAlphanumeric.ReplaceAllString(s, " ")
	// Normalize multiple spaces to single space
	s = multiSpace.ReplaceAllString(s, " ")
	// Trim leading/trailing whitespace
	return strings.TrimSpace(s)
}

// Tokenize splits a normalized title into words.
func Tokenize(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Fields(s)
}

// JaccardSimilarity computes the Jaccard similarity coefficient between two token sets.
// Returns a value between 0.0 (no overlap) and 1.0 (identical sets).
func JaccardSimilarity(tokens1, tokens2 []string) float64 {
	if len(tokens1) == 0 && len(tokens2) == 0 {
		return 1.0
	}
	if len(tokens1) == 0 || len(tokens2) == 0 {
		return 0.0
	}

	// Build sets
	set1 := make(map[string]struct{}, len(tokens1))
	for _, t := range tokens1 {
		set1[t] = struct{}{}
	}
	set2 := make(map[string]struct{}, len(tokens2))
	for _, t := range tokens2 {
		set2[t] = struct{}{}
	}

	// Count intersection
	intersection := 0
	for t := range set1 {
		if _, exists := set2[t]; exists {
			intersection++
		}
	}

	// Union = |A| + |B| - |A ∩ B|
	union := len(set1) + len(set2) - intersection

	if union == 0 {
		return 0.0
	}

	return float64(intersection) / float64(union)
}

// TitleSimilarity is a convenience function that normalizes, tokenizes,
// and computes Jaccard similarity in one call.
func TitleSimilarity(title1, title2 string) float64 {
	norm1 := NormalizeTitle(title1)
	norm2 := NormalizeTitle(title2)
	tokens1 := Tokenize(norm1)
	tokens2 := Tokenize(norm2)
	return JaccardSimilarity(tokens1, tokens2)
}

// IsLikelyMatch returns true if two titles have Jaccard similarity >= threshold.
func IsLikelyMatch(title1, title2 string, threshold float64) bool {
	return TitleSimilarity(title1, title2) >= threshold
}

// RemoveStopWords removes common English stop words from a token list.
// This can improve matching quality by focusing on content words.
func RemoveStopWords(tokens []string) []string {
	stopWords := map[string]struct{}{
		"a": {}, "an": {}, "and": {}, "are": {}, "as": {}, "at": {}, "be": {},
		"by": {}, "for": {}, "from": {}, "has": {}, "he": {}, "in": {}, "is": {},
		"it": {}, "its": {}, "of": {}, "on": {}, "that": {}, "the": {}, "to": {},
		"was": {}, "will": {}, "with": {}, "this": {}, "they": {}, "or": {},
	}

	filtered := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if _, isStop := stopWords[token]; !isStop && token != "" {
			filtered = append(filtered, token)
		}
	}
	return filtered
}

// StripNonAlphanumeric removes all non-alphanumeric characters except spaces.
func StripNonAlphanumeric(s string) string {
	var builder strings.Builder
	builder.Grow(len(s))

	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsSpace(r) {
			builder.WriteRune(r)
		}
	}

	return builder.String()
}
