package arb

import (
	"math"
	"testing"
)

const floatTolerance = 1e-9

func TestComputeROI(t *testing.T) {
	tests := []struct {
		name      string
		edge      float64
		totalCost float64
		expected  float64
	}{
		{
			name:      "positive edge",
			edge:      0.05,
			totalCost: 0.95,
			expected:  5.263157894736842, // (0.05/0.95)*100
		},
		{
			name:      "3% edge",
			edge:      0.03,
			totalCost: 0.97,
			expected:  3.0927835051546393, // (0.03/0.97)*100
		},
		{
			name:      "zero edge",
			edge:      0,
			totalCost: 1.0,
			expected:  0,
		},
		{
			name:      "negative edge",
			edge:      -0.02,
			totalCost: 1.02,
			expected:  -1.9607843137254901, // (-0.02/1.02)*100
		},
		{
			name:      "zero cost",
			edge:      0.1,
			totalCost: 0,
			expected:  0, // Avoid division by zero
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ComputeROI(tt.edge, tt.totalCost)
			if math.Abs(result-tt.expected) > floatTolerance {
				t.Errorf("ComputeROI(%.4f, %.4f) = %.10f, want %.10f",
					tt.edge, tt.totalCost, result, tt.expected)
			}
		})
	}
}

func TestComputeEdge(t *testing.T) {
	tests := []struct {
		name      string
		totalCost float64
		expected  float64
	}{
		{
			name:      "cost below 1",
			totalCost: 0.95,
			expected:  0.05,
		},
		{
			name:      "cost at 1",
			totalCost: 1.0,
			expected:  0,
		},
		{
			name:      "cost above 1",
			totalCost: 1.05,
			expected:  -0.05,
		},
		{
			name:      "cost at 0.5",
			totalCost: 0.5,
			expected:  0.5,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ComputeEdge(tt.totalCost)
			if math.Abs(result-tt.expected) > floatTolerance {
				t.Errorf("ComputeEdge(%.4f) = %.10f, want %.10f",
					tt.totalCost, result, tt.expected)
			}
		})
	}
}

func TestArbitrageScenarios(t *testing.T) {
	tests := []struct {
		name          string
		pmYesAsk      float64
		pmNoAsk       float64
		kalshiYesAsk  float64
		kalshiNoAsk   float64
		expectedCombo string
		expectArb     bool
	}{
		{
			name:          "clear arbitrage PM-YES + K-NO",
			pmYesAsk:      0.45,
			pmNoAsk:       0.60,
			kalshiYesAsk:  0.55,
			kalshiNoAsk:   0.45,
			expectedCombo: "PM-YES + K-NO",
			expectArb:     true, // 0.45 + 0.45 = 0.90 < 1.0
		},
		{
			name:          "clear arbitrage K-YES + PM-NO",
			pmYesAsk:      0.60,
			pmNoAsk:       0.42,
			kalshiYesAsk:  0.52,
			kalshiNoAsk:   0.48,
			expectedCombo: "K-YES + PM-NO",
			expectArb:     true, // 0.52 + 0.42 = 0.94 < 1.0
		},
		{
			name:         "no arbitrage - efficient market",
			pmYesAsk:     0.50,
			pmNoAsk:      0.50,
			kalshiYesAsk: 0.50,
			kalshiNoAsk:  0.50,
			expectArb:    false, // 0.50 + 0.50 = 1.0
		},
		{
			name:         "no arbitrage - loss scenario",
			pmYesAsk:     0.55,
			pmNoAsk:      0.60,
			kalshiYesAsk: 0.60,
			kalshiNoAsk:  0.55,
			expectArb:    false, // Both combos > 1.0
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Check PM-YES + K-NO combo
			totalCost1 := tt.pmYesAsk + tt.kalshiNoAsk
			edge1 := ComputeEdge(totalCost1)
			roi1 := ComputeROI(edge1, totalCost1)

			// Check K-YES + PM-NO combo
			totalCost2 := tt.kalshiYesAsk + tt.pmNoAsk
			edge2 := ComputeEdge(totalCost2)
			roi2 := ComputeROI(edge2, totalCost2)

			hasArb := (roi1 > 0) || (roi2 > 0)

			if hasArb != tt.expectArb {
				t.Errorf("Expected arbitrage: %v, got: %v (ROI1: %.2f%%, ROI2: %.2f%%)",
					tt.expectArb, hasArb, roi1, roi2)
			}

			if tt.expectArb && tt.expectedCombo == "PM-YES + K-NO" {
				if edge1 <= 0 {
					t.Errorf("Expected positive edge for PM-YES + K-NO, got %.4f", edge1)
				}
			}

			if tt.expectArb && tt.expectedCombo == "K-YES + PM-NO" {
				if edge2 <= 0 {
					t.Errorf("Expected positive edge for K-YES + PM-NO, got %.4f", edge2)
				}
			}
		})
	}
}

func BenchmarkComputeROI(b *testing.B) {
	for i := 0; i < b.N; i++ {
		ComputeROI(0.05, 0.95)
	}
}

func BenchmarkComputeEdge(b *testing.B) {
	for i := 0; i < b.N; i++ {
		ComputeEdge(0.95)
	}
}
