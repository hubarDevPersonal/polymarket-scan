package ws

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/artemgubar/prediction-markets/arb-ws/internal/metrics"
	"github.com/gorilla/websocket"
)

const (
	kalshiWSURL          = "wss://api.elections.kalshi.com/trade-api/ws/v2"
	kalshiRESTURL        = "https://api.elections.kalshi.com/trade-api/v2/markets"
	kalshiPingInterval   = 30 * time.Second
	kalshiReadDeadline   = 60 * time.Second
	kalshiReconnectBaseDelay = 2 * time.Second
	kalshiMaxReconnectDelay  = 60 * time.Second
)

// KalshiMarket represents a market from Kalshi REST API
type KalshiMarket struct {
	Ticker      string  `json:"ticker"`
	Title       string  `json:"title"`
	Status      string  `json:"status"`
	YesBid      float64 `json:"yes_bid"`
	YesAsk      float64 `json:"yes_ask"`
	CloseTime   string  `json:"close_time"`
	ExpirationTime string `json:"expiration_time"`
}

// KalshiSubscribeMsg is the subscription message for Kalshi WS
type KalshiSubscribeMsg struct {
	Type    string `json:"type"`
	Channel string `json:"channel"`
	Ticker  string `json:"ticker,omitempty"`
}

// KalshiMessage represents incoming WebSocket messages from Kalshi
type KalshiMessage struct {
	Type    string          `json:"type"`
	Channel string          `json:"channel"`
	Ticker  string          `json:"ticker"`
	YesBid  float64         `json:"yes_bid"`
	YesAsk  float64         `json:"yes_ask"`
	Price   float64         `json:"price"`
}

// KalshiPriceUpdate represents a price update for a Kalshi market
type KalshiPriceUpdate struct {
	Ticker string
	YesBid float64
	YesAsk float64
	NoBid  float64 // Computed as 1 - YesAsk
	NoAsk  float64 // Computed as 1 - YesBid
}

// KalshiClient manages WebSocket connection to Kalshi
type KalshiClient struct {
	mu          sync.RWMutex
	conn        *websocket.Conn
	ctx         context.Context
	cancel      context.CancelFunc
	keyID       string
	privateKey  *rsa.PrivateKey
	tickers     []string
	prices      map[string]*KalshiPriceUpdate // ticker -> price update
	priceChan   chan KalshiPriceUpdate
	reconnectCh chan struct{}
	connected   bool
	enabled     bool
	logger      *slog.Logger
}

// NewKalshiClient creates a new Kalshi WebSocket client
func NewKalshiClient(ctx context.Context, keyID, keyPath string, tickers []string, logger *slog.Logger) (*KalshiClient, error) {
	ctx, cancel := context.WithCancel(ctx)

	client := &KalshiClient{
		ctx:         ctx,
		cancel:      cancel,
		keyID:       keyID,
		tickers:     tickers,
		prices:      make(map[string]*KalshiPriceUpdate),
		priceChan:   make(chan KalshiPriceUpdate, 1000),
		reconnectCh: make(chan struct{}, 1),
		logger:      logger,
	}

	// Check if Kalshi credentials are provided
	if keyID == "" || keyPath == "" {
		logger.Warn("kalshi credentials not provided, kalshi websocket disabled")
		client.enabled = false
		return client, nil
	}

	// Load private key
	privateKey, err := loadPrivateKey(keyPath)
	if err != nil {
		logger.Warn("failed to load kalshi private key, kalshi websocket disabled", "error", err)
		client.enabled = false
		return client, nil
	}

	client.privateKey = privateKey
	client.enabled = true
	logger.Info("kalshi client initialized", "key_id", keyID)

	return client, nil
}

// loadPrivateKey loads an RSA private key from a PEM file
func loadPrivateKey(path string) (*rsa.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read key file: %w", err)
	}

	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}

	// Try parsing as PKCS8 first (more common)
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok {
			return rsaKey, nil
		}
		return nil, fmt.Errorf("key is not RSA")
	}

	// Fall back to PKCS1
	rsaKey, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}

	return rsaKey, nil
}

// Start initiates the WebSocket connection with automatic reconnection
func (c *KalshiClient) Start() error {
	if !c.enabled {
		c.logger.Info("kalshi client disabled, skipping start")
		return nil
	}

	go c.connectionManager()
	return nil
}

// connectionManager handles reconnection logic with exponential backoff
func (c *KalshiClient) connectionManager() {
	delay := kalshiReconnectBaseDelay

	for {
		select {
		case <-c.ctx.Done():
			c.logger.Info("kalshi connection manager stopping")
			return
		default:
		}

		err := c.connect()
		if err != nil {
			c.logger.Error("kalshi connection failed", "error", err)
			metrics.RecordWSReconnect("kalshi")
			metrics.SetWSConnectionStatus("kalshi", false)

			select {
			case <-c.ctx.Done():
				return
			case <-time.After(delay):
				// Exponential backoff
				delay *= 2
				if delay > kalshiMaxReconnectDelay {
					delay = kalshiMaxReconnectDelay
				}
			}
			continue
		}

		// Reset delay on successful connection
		delay = kalshiReconnectBaseDelay
		metrics.SetWSConnectionStatus("kalshi", true)

		// Wait for reconnect signal or context cancellation
		select {
		case <-c.reconnectCh:
			c.logger.Info("kalshi reconnect triggered")
		case <-c.ctx.Done():
			return
		}
	}
}

// connect establishes WebSocket connection with authentication
func (c *KalshiClient) connect() error {
	c.logger.Info("connecting to kalshi", "url", kalshiWSURL)

	// Generate authentication headers
	headers, err := c.generateAuthHeaders()
	if err != nil {
		return fmt.Errorf("generate auth headers: %w", err)
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.Dial(kalshiWSURL, headers)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.connected = true
	c.mu.Unlock()

	// Subscribe to ticker channel
	if err := c.subscribe(); err != nil {
		conn.Close()
		return fmt.Errorf("subscribe failed: %w", err)
	}

	c.logger.Info("kalshi connected and subscribed", "tickers", len(c.tickers))

	// Start ping/pong and read loops
	go c.pingLoop()
	go c.readLoop()

	return nil
}

// generateAuthHeaders creates authentication headers for Kalshi WebSocket
func (c *KalshiClient) generateAuthHeaders() (http.Header, error) {
	timestamp := time.Now().UnixMilli()
	message := fmt.Sprintf("%dGET/trade-api/ws/v2", timestamp)

	// Sign with RSA-PSS
	hashed := sha256.Sum256([]byte(message))
	signature, err := rsa.SignPSS(rand.Reader, c.privateKey, crypto.SHA256, hashed[:], nil)
	if err != nil {
		return nil, fmt.Errorf("sign message: %w", err)
	}

	signatureB64 := base64.StdEncoding.EncodeToString(signature)

	headers := http.Header{}
	headers.Set("KALSHI-ACCESS-KEY", c.keyID)
	headers.Set("KALSHI-ACCESS-SIGNATURE", signatureB64)
	headers.Set("KALSHI-ACCESS-TIMESTAMP", fmt.Sprintf("%d", timestamp))

	return headers, nil
}

// subscribe sends subscription messages for all tickers
func (c *KalshiClient) subscribe() error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()

	if conn == nil {
		return fmt.Errorf("no connection")
	}

	// Subscribe to the ticker channel (market-wide updates)
	msg := KalshiSubscribeMsg{
		Type:    "subscribe",
		Channel: "ticker",
	}

	if err := conn.WriteJSON(msg); err != nil {
		return fmt.Errorf("write subscription: %w", err)
	}

	c.logger.Debug("kalshi subscribed to ticker channel")

	return nil
}

// pingLoop sends periodic pings to keep connection alive
func (c *KalshiClient) pingLoop() {
	ticker := time.NewTicker(kalshiPingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			c.mu.RLock()
			conn := c.conn
			c.mu.RUnlock()

			if conn == nil {
				return
			}

			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.logger.Error("kalshi ping failed", "error", err)
				c.triggerReconnect()
				return
			}
		}
	}
}

// readLoop reads messages from WebSocket
func (c *KalshiClient) readLoop() {
	defer c.triggerReconnect()

	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()

	if conn == nil {
		return
	}

	for {
		if err := conn.SetReadDeadline(time.Now().Add(kalshiReadDeadline)); err != nil {
			c.logger.Error("kalshi set read deadline failed", "error", err)
			return
		}

		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.logger.Error("kalshi read error", "error", err)
			}
			return
		}

		c.handleMessage(message)
	}
}

// handleMessage processes incoming WebSocket messages
func (c *KalshiClient) handleMessage(data []byte) {
	var msg KalshiMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		c.logger.Debug("kalshi unmarshal failed", "error", err)
		return
	}

	// Handle ticker updates
	if msg.Channel == "ticker" && msg.Ticker != "" {
		update := KalshiPriceUpdate{
			Ticker: msg.Ticker,
			YesBid: msg.YesBid,
			YesAsk: msg.YesAsk,
			NoBid:  1.0 - msg.YesAsk, // NO bid = 1 - YES ask
			NoAsk:  1.0 - msg.YesBid, // NO ask = 1 - YES bid
		}

		// Update internal state
		c.mu.Lock()
		c.prices[msg.Ticker] = &update
		c.mu.Unlock()

		metrics.RecordPriceUpdate("kalshi")

		// Send to channel
		select {
		case c.priceChan <- update:
		default:
			c.logger.Warn("kalshi price channel full, dropping update")
		}
	}
}

// triggerReconnect signals the connection manager to reconnect
func (c *KalshiClient) triggerReconnect() {
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.connected = false
	c.mu.Unlock()

	metrics.SetWSConnectionStatus("kalshi", false)

	select {
	case c.reconnectCh <- struct{}{}:
	default:
	}
}

// GetPriceChannel returns the channel for receiving price updates
func (c *KalshiClient) GetPriceChannel() <-chan KalshiPriceUpdate {
	return c.priceChan
}

// GetPrice returns the current price for a ticker
func (c *KalshiClient) GetPrice(ticker string) (yesBid, yesAsk, noBid, noAsk float64, ok bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if p, found := c.prices[ticker]; found {
		return p.YesBid, p.YesAsk, p.NoBid, p.NoAsk, true
	}
	return 0, 0, 0, 0, false
}

// IsConnected returns whether the client is currently connected
func (c *KalshiClient) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

// IsEnabled returns whether the Kalshi client is enabled
func (c *KalshiClient) IsEnabled() bool {
	return c.enabled
}

// Close gracefully closes the WebSocket connection
func (c *KalshiClient) Close() error {
	c.cancel()
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		return err
	}
	return nil
}
