package http

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/artemgubar/prediction-markets/arb-ws/internal/arb"
	"github.com/artemgubar/prediction-markets/arb-ws/internal/metrics"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Server provides HTTP endpoints for the arbitrage service
type Server struct {
	addr   string
	engine *arb.Engine
	logger *slog.Logger
	server *http.Server
}

// NewServer creates a new HTTP server
func NewServer(addr string, engine *arb.Engine, logger *slog.Logger) *Server {
	return &Server{
		addr:   addr,
		engine: engine,
		logger: logger,
	}
}

// Start starts the HTTP server
func (s *Server) Start() error {
	mux := http.NewServeMux()

	// Register routes
	mux.HandleFunc("/healthz", s.loggingMiddleware(s.handleHealthz))
	mux.HandleFunc("/arbs", s.loggingMiddleware(s.handleArbs))
	mux.Handle("/metrics", promhttp.Handler())

	s.server = &http.Server{
		Addr:         s.addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	s.logger.Info("http server starting", "addr", s.addr)

	if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}

	return nil
}

// Shutdown gracefully shuts down the HTTP server
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("http server shutting down")
	return s.server.Shutdown(ctx)
}

// loggingMiddleware logs HTTP requests and records metrics
func (s *Server) loggingMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Create a response writer wrapper to capture status code
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		// Call the next handler
		next(rw, r)

		// Log and record metrics
		duration := time.Since(start)
		statusCode := strconv.Itoa(rw.statusCode)

		s.logger.Info("http request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", statusCode,
			"duration_ms", duration.Milliseconds(),
			"remote_addr", r.RemoteAddr,
		)

		metrics.RecordHTTPRequest(r.URL.Path, statusCode)
	}
}

// responseWriter wraps http.ResponseWriter to capture the status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// handleHealthz returns a simple health check response
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

// handleArbs returns the current list of arbitrage opportunities
func (s *Server) handleArbs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get opportunities from engine
	opportunities := s.engine.GetOpportunities()

	// Return JSON
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	if err := json.NewEncoder(w).Encode(opportunities); err != nil {
		s.logger.Error("failed to encode opportunities", "error", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

// ErrorResponse represents an error response
type ErrorResponse struct {
	Error string `json:"error"`
}

// writeJSON writes a JSON response
func writeJSON(w http.ResponseWriter, statusCode int, data interface{}) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	return json.NewEncoder(w).Encode(data)
}

// writeError writes an error response
func writeError(w http.ResponseWriter, statusCode int, message string) {
	writeJSON(w, statusCode, ErrorResponse{Error: message})
}
