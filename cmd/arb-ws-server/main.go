package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/artemgubar/prediction-markets/arb-ws/internal/arb"
	"github.com/artemgubar/prediction-markets/arb-ws/internal/config"
	httpserver "github.com/artemgubar/prediction-markets/arb-ws/internal/http"
	"github.com/artemgubar/prediction-markets/arb-ws/internal/match"
	"github.com/artemgubar/prediction-markets/arb-ws/internal/ws"
)

func main() {
	// Setup structured logging
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	logger.Info("starting arb-ws-server")

	// Load configuration
	cfg := config.Load()
	logger.Info("configuration loaded",
		"http_addr", cfg.HTTPAddr,
		"edge_threshold", cfg.EdgeMinRORPct,
		"title_sim", cfg.TitleSim,
		"time_window_h", cfg.TimeWindowH,
		"pm_chunk", cfg.PMChunk,
	)

	// Create context that can be cancelled
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Bootstrap: Fetch markets and create pairs
	logger.Info("bootstrapping: fetching markets and creating pairs")
	pairs, pmTokenIDs, kalshiTickers, err := bootstrap(ctx, cfg, logger)
	if err != nil {
		logger.Error("bootstrap failed", "error", err)
		os.Exit(1)
	}

	logger.Info("bootstrap complete",
		"pairs", len(pairs),
		"pm_tokens", len(pmTokenIDs),
		"kalshi_tickers", len(kalshiTickers),
	)

	// Initialize Polymarket WebSocket client
	pmClient := ws.NewPolymarketClient(ctx, pmTokenIDs, cfg.PMChunk, logger)
	if err := pmClient.Start(); err != nil {
		logger.Error("failed to start polymarket client", "error", err)
		os.Exit(1)
	}
	defer pmClient.Close()

	// Initialize Kalshi WebSocket client
	kalshiClient, err := ws.NewKalshiClient(ctx, cfg.KalshiKeyID, cfg.KalshiKeyPath, kalshiTickers, logger)
	if err != nil {
		logger.Error("failed to create kalshi client", "error", err)
		os.Exit(1)
	}
	if err := kalshiClient.Start(); err != nil {
		logger.Error("failed to start kalshi client", "error", err)
		os.Exit(1)
	}
	defer kalshiClient.Close()

	// Initialize arbitrage engine
	engine := arb.NewEngine(ctx, pairs, pmClient, kalshiClient, cfg.EdgeMinRORPct, logger)
	engine.Start()

	// Initialize HTTP server
	server := httpserver.NewServer(cfg.HTTPAddr, engine, logger)

	// Start HTTP server in goroutine
	go func() {
		if err := server.Start(); err != nil {
			logger.Error("http server error", "error", err)
		}
	}()

	// Wait for interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan

	logger.Info("shutting down gracefully")

	// Graceful shutdown with timeout
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("http server shutdown error", "error", err)
	}

	logger.Info("shutdown complete")
}

// bootstrap fetches markets from both exchanges and creates market pairs
func bootstrap(ctx context.Context, cfg *config.Config, logger *slog.Logger) ([]arb.MarketPair, []string, []string, error) {
	// Fetch Polymarket markets
	logger.Info("fetching polymarket markets")
	pmMarkets, err := fetchPolymarketMarkets(ctx, logger)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("fetch polymarket markets: %w", err)
	}
	logger.Info("polymarket markets fetched", "count", len(pmMarkets))

	// Fetch Kalshi markets
	logger.Info("fetching kalshi markets")
	kalshiMarkets, err := fetchKalshiMarkets(ctx, logger)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("fetch kalshi markets: %w", err)
	}
	logger.Info("kalshi markets fetched", "count", len(kalshiMarkets))

	// Create market pairs using title similarity
	logger.Info("creating market pairs", "threshold", cfg.TitleSim)
	pairs := createMarketPairs(pmMarkets, kalshiMarkets, cfg.TitleSim, cfg.TimeWindowH, logger)

	// Extract token IDs and tickers
	pmTokenIDs := extractPMTokenIDs(pairs)
	kalshiTickers := extractKalshiTickers(pairs)

	return pairs, pmTokenIDs, kalshiTickers, nil
}

// fetchPolymarketMarkets fetches open markets from Polymarket REST API
func fetchPolymarketMarkets(ctx context.Context, logger *slog.Logger) ([]ws.PolymarketMarket, error) {
	markets := make([]ws.PolymarketMarket, 0)
	nextCursor := ""

	// Follow pagination
	for {
		url := "https://clob.polymarket.com/markets"
		if nextCursor != "" {
			url = fmt.Sprintf("%s?next_cursor=%s", url, nextCursor)
		}

		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("http request: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
		}

		var result struct {
			Data       []ws.PolymarketMarket `json:"data"`
			NextCursor string                `json:"next_cursor"`
		}

		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return nil, fmt.Errorf("decode response: %w", err)
		}

		// Filter for active/open markets
		for _, m := range result.Data {
			if m.Active && !m.Closed {
				markets = append(markets, m)
			}
		}

		nextCursor = result.NextCursor
		if nextCursor == "" {
			break
		}

		logger.Debug("polymarket pagination", "fetched", len(markets), "next_cursor", nextCursor)
	}

	return markets, nil
}

// fetchKalshiMarkets fetches open markets from Kalshi REST API
func fetchKalshiMarkets(ctx context.Context, logger *slog.Logger) ([]ws.KalshiMarket, error) {
	markets := make([]ws.KalshiMarket, 0)
	cursor := ""

	// Follow pagination
	for {
		url := "https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=1000"
		if cursor != "" {
			url = fmt.Sprintf("%s&cursor=%s", url, cursor)
		}

		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("http request: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
		}

		var result struct {
			Markets []ws.KalshiMarket `json:"markets"`
			Cursor  string            `json:"cursor"`
		}

		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return nil, fmt.Errorf("decode response: %w", err)
		}

		markets = append(markets, result.Markets...)

		cursor = result.Cursor
		if cursor == "" {
			break
		}

		logger.Debug("kalshi pagination", "fetched", len(markets), "cursor", cursor)
	}

	return markets, nil
}

// createMarketPairs matches markets between exchanges using title similarity
func createMarketPairs(pmMarkets []ws.PolymarketMarket, kalshiMarkets []ws.KalshiMarket, threshold float64, timeWindowH int, logger *slog.Logger) []arb.MarketPair {
	pairs := make([]arb.MarketPair, 0)
	timeWindow := time.Duration(timeWindowH) * time.Hour

	for _, pm := range pmMarkets {
		for _, k := range kalshiMarkets {
			// Check title similarity
			if !match.IsLikelyMatch(pm.Question, k.Title, threshold) {
				continue
			}

			// Soft deadline check if timestamps available
			if pm.EndDateISO != "" && k.ExpirationTime != "" {
				pmEnd, err1 := time.Parse(time.RFC3339, pm.EndDateISO)
				kEnd, err2 := time.Parse(time.RFC3339, k.ExpirationTime)

				if err1 == nil && err2 == nil {
					diff := pmEnd.Sub(kEnd)
					if diff < 0 {
						diff = -diff
					}
					if diff > timeWindow {
						continue // Expiration times too far apart
					}
				}
			}

			// Find YES and NO tokens for Polymarket
			var yesTokenID, noTokenID string
			for _, token := range pm.Tokens {
				if token.Outcome == "YES" {
					yesTokenID = token.TokenID
				} else if token.Outcome == "NO" {
					noTokenID = token.TokenID
				}
			}

			if yesTokenID == "" || noTokenID == "" {
				logger.Debug("skipping pm market without yes/no tokens", "question", pm.Question)
				continue
			}

			pair := arb.MarketPair{
				PMTokenYes:   yesTokenID,
				PMTokenNo:    noTokenID,
				PMTitle:      pm.Question,
				KalshiTicker: k.Ticker,
				KalshiTitle:  k.Title,
			}

			pairs = append(pairs, pair)
			logger.Debug("market pair created",
				"pm_title", pm.Question,
				"kalshi_title", k.Title,
				"similarity", fmt.Sprintf("%.2f", match.TitleSimilarity(pm.Question, k.Title)),
			)
		}
	}

	return pairs
}

// extractPMTokenIDs extracts all Polymarket token IDs from pairs
func extractPMTokenIDs(pairs []arb.MarketPair) []string {
	tokenSet := make(map[string]struct{})
	for _, p := range pairs {
		tokenSet[p.PMTokenYes] = struct{}{}
		tokenSet[p.PMTokenNo] = struct{}{}
	}

	tokens := make([]string, 0, len(tokenSet))
	for token := range tokenSet {
		tokens = append(tokens, token)
	}
	return tokens
}

// extractKalshiTickers extracts all Kalshi tickers from pairs
func extractKalshiTickers(pairs []arb.MarketPair) []string {
	tickerSet := make(map[string]struct{})
	for _, p := range pairs {
		tickerSet[p.KalshiTicker] = struct{}{}
	}

	tickers := make([]string, 0, len(tickerSet))
	for ticker := range tickerSet {
		tickers = append(tickers, ticker)
	}
	return tickers
}
