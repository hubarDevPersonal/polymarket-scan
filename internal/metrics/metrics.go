package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// ArbPairsTotal tracks the total number of market pairs being monitored
	ArbPairsTotal = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "arb_pairs_total",
		Help: "Total number of market pairs being monitored for arbitrage",
	})

	// WSReconnectsTotal tracks WebSocket reconnection attempts by source
	WSReconnectsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "arb_ws_reconnects_total",
		Help: "Total number of WebSocket reconnection attempts",
	}, []string{"source"})

	// OpportunitiesFoundTotal tracks total arbitrage opportunities detected
	OpportunitiesFoundTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "arb_opps_found_total",
		Help: "Total number of arbitrage opportunities found",
	})

	// HTTPRequestsTotal tracks HTTP requests by path and status code
	HTTPRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total",
		Help: "Total number of HTTP requests",
	}, []string{"path", "code"})

	// WSConnectionStatus tracks current WebSocket connection status
	WSConnectionStatus = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "arb_ws_connection_status",
		Help: "WebSocket connection status (1 = connected, 0 = disconnected)",
	}, []string{"source"})

	// PriceUpdatesTotal tracks total price updates received
	PriceUpdatesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "arb_price_updates_total",
		Help: "Total number of price updates received",
	}, []string{"source"})

	// CurrentOpportunitiesGauge tracks current number of active arbitrage opportunities
	CurrentOpportunitiesGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "arb_current_opportunities",
		Help: "Current number of active arbitrage opportunities",
	})

	// BestEdgeGauge tracks the best current edge percentage
	BestEdgeGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "arb_best_edge_pct",
		Help: "Best current arbitrage edge percentage",
	})
)

// RecordWSReconnect increments the reconnect counter for a source
func RecordWSReconnect(source string) {
	WSReconnectsTotal.WithLabelValues(source).Inc()
}

// RecordHTTPRequest increments the HTTP request counter
func RecordHTTPRequest(path, code string) {
	HTTPRequestsTotal.WithLabelValues(path, code).Inc()
}

// SetWSConnectionStatus sets the connection status for a source
func SetWSConnectionStatus(source string, connected bool) {
	val := 0.0
	if connected {
		val = 1.0
	}
	WSConnectionStatus.WithLabelValues(source).Set(val)
}

// RecordPriceUpdate increments the price update counter for a source
func RecordPriceUpdate(source string) {
	PriceUpdatesTotal.WithLabelValues(source).Inc()
}

// RecordOpportunityFound increments the opportunities found counter
func RecordOpportunityFound() {
	OpportunitiesFoundTotal.Inc()
}

// UpdateCurrentOpportunities updates the gauge for current opportunities
func UpdateCurrentOpportunities(count int) {
	CurrentOpportunitiesGauge.Set(float64(count))
}

// UpdateBestEdge updates the best edge gauge
func UpdateBestEdge(edgePct float64) {
	BestEdgeGauge.Set(edgePct)
}

// SetArbPairs sets the total number of monitored pairs
func SetArbPairs(count int) {
	ArbPairsTotal.Set(float64(count))
}
