package arb

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/artemgubar/prediction-markets/arb-ws/internal/metrics"
	"github.com/artemgubar/prediction-markets/arb-ws/internal/ws"
)

// MarketPair represents a matched market pair between Polymarket and Kalshi
type MarketPair struct {
	PMTokenYes   string
	PMTokenNo    string
	PMTitle      string
	KalshiTicker string
	KalshiTitle  string
}

// Opportunity represents an arbitrage opportunity
type Opportunity struct {
	Timestamp    time.Time `json:"timestamp"`
	Combo        string    `json:"combo"`         // "PM-YES + K-NO" or "K-YES + PM-NO"
	EdgeAbs      float64   `json:"edge_abs"`      // Absolute edge: 1 - total_cost
	EdgePctTurn  float64   `json:"edge_pct_turn"` // ROI on turnover: edge_abs / total_cost * 100
	PMTitle      string    `json:"pm_title"`
	PMYesAsk     float64   `json:"pm_yes_ask"`
	PMNoAsk      float64   `json:"pm_no_ask"`
	KalshiTicker string    `json:"kalshi_ticker"`
	KalshiTitle  string    `json:"kalshi_title"`
	KalshiYesBid float64   `json:"kalshi_yes_bid"`
	KalshiYesAsk float64   `json:"kalshi_yes_ask"`
	KalshiNoBid  float64   `json:"kalshi_no_bid"`
	KalshiNoAsk  float64   `json:"kalshi_no_ask"`
	TotalCost    float64   `json:"total_cost"`
}

// Engine monitors market pairs and detects arbitrage opportunities
type Engine struct {
	mu              sync.RWMutex
	ctx             context.Context
	pairs           []MarketPair
	pmClient        *ws.PolymarketClient
	kalshiClient    *ws.KalshiClient
	edgeThreshold   float64 // Minimum edge percentage for ROI on turnover
	opportunities   []Opportunity
	maxOpps         int
	logger          *slog.Logger
}

// NewEngine creates a new arbitrage engine
func NewEngine(ctx context.Context, pairs []MarketPair, pmClient *ws.PolymarketClient, kalshiClient *ws.KalshiClient, edgeThreshold float64, logger *slog.Logger) *Engine {
	return &Engine{
		ctx:           ctx,
		pairs:         pairs,
		pmClient:      pmClient,
		kalshiClient:  kalshiClient,
		edgeThreshold: edgeThreshold,
		opportunities: make([]Opportunity, 0),
		maxOpps:       1000, // Keep up to 1000 opportunities in memory
		logger:        logger,
	}
}

// Start begins monitoring for arbitrage opportunities
func (e *Engine) Start() {
	e.logger.Info("arbitrage engine starting", "pairs", len(e.pairs), "threshold", e.edgeThreshold)
	metrics.SetArbPairs(len(e.pairs))

	// Start continuous computation in a goroutine
	go e.computeLoop()
}

// computeLoop continuously computes arbitrage opportunities
func (e *Engine) computeLoop() {
	ticker := time.NewTicker(1 * time.Second) // Compute every second
	defer ticker.Stop()

	for {
		select {
		case <-e.ctx.Done():
			e.logger.Info("arbitrage engine stopping")
			return
		case <-ticker.C:
			e.computeOpportunities()
		}
	}
}

// computeOpportunities scans all pairs and identifies arbitrage opportunities
func (e *Engine) computeOpportunities() {
	newOpps := make([]Opportunity, 0, 100)

	for _, pair := range e.pairs {
		// Get Polymarket prices
		pmYesAsk, _, pmOk := e.pmClient.GetPrice(pair.PMTokenYes)
		pmNoAsk, _, pmNoOk := e.pmClient.GetPrice(pair.PMTokenNo)

		if !pmOk || !pmNoOk || pmYesAsk == 0 || pmNoAsk == 0 {
			continue // Missing Polymarket prices
		}

		// Get Kalshi prices (only if enabled)
		if !e.kalshiClient.IsEnabled() {
			continue
		}

		kalshiYesBid, kalshiYesAsk, kalshiNoBid, kalshiNoAsk, kalshiOk := e.kalshiClient.GetPrice(pair.KalshiTicker)
		if !kalshiOk || kalshiYesBid == 0 || kalshiYesAsk == 0 {
			continue // Missing Kalshi prices
		}

		// Compute two combinations:
		// 1. PM-YES + K-NO: Buy YES on PM, buy NO on Kalshi
		// 2. K-YES + PM-NO: Buy YES on Kalshi, buy NO on PM

		// Combo 1: PM-YES + K-NO
		totalCost1 := pmYesAsk + kalshiNoAsk
		edgeAbs1 := 1.0 - totalCost1
		if totalCost1 > 0 {
			edgePctTurn1 := (edgeAbs1 / totalCost1) * 100.0

			if edgePctTurn1 >= e.edgeThreshold {
				opp := Opportunity{
					Timestamp:    time.Now(),
					Combo:        "PM-YES + K-NO",
					EdgeAbs:      edgeAbs1,
					EdgePctTurn:  edgePctTurn1,
					PMTitle:      pair.PMTitle,
					PMYesAsk:     pmYesAsk,
					PMNoAsk:      pmNoAsk,
					KalshiTicker: pair.KalshiTicker,
					KalshiTitle:  pair.KalshiTitle,
					KalshiYesBid: kalshiYesBid,
					KalshiYesAsk: kalshiYesAsk,
					KalshiNoBid:  kalshiNoBid,
					KalshiNoAsk:  kalshiNoAsk,
					TotalCost:    totalCost1,
				}
				newOpps = append(newOpps, opp)
				metrics.RecordOpportunityFound()
			}
		}

		// Combo 2: K-YES + PM-NO
		totalCost2 := kalshiYesAsk + pmNoAsk
		edgeAbs2 := 1.0 - totalCost2
		if totalCost2 > 0 {
			edgePctTurn2 := (edgeAbs2 / totalCost2) * 100.0

			if edgePctTurn2 >= e.edgeThreshold {
				opp := Opportunity{
					Timestamp:    time.Now(),
					Combo:        "K-YES + PM-NO",
					EdgeAbs:      edgeAbs2,
					EdgePctTurn:  edgePctTurn2,
					PMTitle:      pair.PMTitle,
					PMYesAsk:     pmYesAsk,
					PMNoAsk:      pmNoAsk,
					KalshiTicker: pair.KalshiTicker,
					KalshiTitle:  pair.KalshiTitle,
					KalshiYesBid: kalshiYesBid,
					KalshiYesAsk: kalshiYesAsk,
					KalshiNoBid:  kalshiNoBid,
					KalshiNoAsk:  kalshiNoAsk,
					TotalCost:    totalCost2,
				}
				newOpps = append(newOpps, opp)
				metrics.RecordOpportunityFound()
			}
		}
	}

	// Sort by edge percentage descending
	sort.Slice(newOpps, func(i, j int) bool {
		return newOpps[i].EdgePctTurn > newOpps[j].EdgePctTurn
	})

	// Update opportunities with limit
	e.mu.Lock()
	e.opportunities = newOpps
	if len(e.opportunities) > e.maxOpps {
		e.opportunities = e.opportunities[:e.maxOpps]
	}
	e.mu.Unlock()

	// Update metrics
	metrics.UpdateCurrentOpportunities(len(newOpps))
	if len(newOpps) > 0 {
		metrics.UpdateBestEdge(newOpps[0].EdgePctTurn)
	} else {
		metrics.UpdateBestEdge(0)
	}
}

// GetOpportunities returns the current list of arbitrage opportunities
func (e *Engine) GetOpportunities() []Opportunity {
	e.mu.RLock()
	defer e.mu.RUnlock()

	// Return a copy to avoid race conditions
	result := make([]Opportunity, len(e.opportunities))
	copy(result, e.opportunities)
	return result
}

// GetOpportunitiesTop returns the top N arbitrage opportunities
func (e *Engine) GetOpportunitiesTop(n int) []Opportunity {
	e.mu.RLock()
	defer e.mu.RUnlock()

	if len(e.opportunities) < n {
		n = len(e.opportunities)
	}

	result := make([]Opportunity, n)
	copy(result, e.opportunities[:n])
	return result
}

// ComputeROI calculates ROI on turnover for a given edge and total cost
func ComputeROI(edge, totalCost float64) float64 {
	if totalCost <= 0 {
		return 0
	}
	return (edge / totalCost) * 100.0
}

// ComputeEdge calculates the absolute edge (1 - total cost)
func ComputeEdge(totalCost float64) float64 {
	return 1.0 - totalCost
}
