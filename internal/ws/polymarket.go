package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/artemgubar/prediction-markets/arb-ws/internal/metrics"
	"github.com/gorilla/websocket"
)

const (
	polymarketWSURL     = "wss://ws-subscriptions-clob.polymarket.com/ws/"
	polymarketRESTURL   = "https://clob.polymarket.com/markets"
	pmPingInterval      = 30 * time.Second
	pmReadDeadline      = 60 * time.Second
	pmReconnectBaseDelay = 2 * time.Second
	pmMaxReconnectDelay  = 60 * time.Second
)

// PolymarketMarket represents a market from Polymarket REST API
type PolymarketMarket struct {
	ConditionID string   `json:"condition_id"`
	QuestionID  string   `json:"question_id"`
	Question    string   `json:"question"`
	Tokens      []PMToken `json:"tokens"`
	Active      bool     `json:"active"`
	Closed      bool     `json:"closed"`
	EndDateISO  string   `json:"end_date_iso"`
}

// PMToken represents a token (outcome) in a Polymarket market
type PMToken struct {
	TokenID string  `json:"token_id"`
	Outcome string  `json:"outcome"`
	Price   float64 `json:"price,string"`
}

// PMSubscribeMsg is the subscription message for Polymarket WS
type PMSubscribeMsg struct {
	Type      string   `json:"type"`
	AssetsIDs []string `json:"assets_ids"`
}

// PMMessage represents incoming WebSocket messages from Polymarket
type PMMessage struct {
	EventType string          `json:"event_type"`
	Market    string          `json:"market"`
	Asset     string          `json:"asset"`
	Price     float64         `json:"price,string"`
	Side      string          `json:"side"`
	Size      float64         `json:"size,string"`
	Book      json.RawMessage `json:"book"`
}

// PMPriceUpdate represents a price update for an outcome
type PMPriceUpdate struct {
	TokenID string
	Outcome string  // "YES" or "NO"
	Ask     float64 // Best ask price
	Bid     float64 // Best bid price
}

// PolymarketClient manages WebSocket connection to Polymarket
type PolymarketClient struct {
	mu          sync.RWMutex
	conn        *websocket.Conn
	ctx         context.Context
	cancel      context.CancelFunc
	tokenIDs    []string
	chunkSize   int
	prices      map[string]*PMPriceUpdate // tokenID -> price update
	priceChan   chan PMPriceUpdate
	reconnectCh chan struct{}
	connected   bool
	logger      *slog.Logger
}

// NewPolymarketClient creates a new Polymarket WebSocket client
func NewPolymarketClient(ctx context.Context, tokenIDs []string, chunkSize int, logger *slog.Logger) *PolymarketClient {
	ctx, cancel := context.WithCancel(ctx)
	return &PolymarketClient{
		ctx:         ctx,
		cancel:      cancel,
		tokenIDs:    tokenIDs,
		chunkSize:   chunkSize,
		prices:      make(map[string]*PMPriceUpdate),
		priceChan:   make(chan PMPriceUpdate, 1000),
		reconnectCh: make(chan struct{}, 1),
		logger:      logger,
	}
}

// Start initiates the WebSocket connection with automatic reconnection
func (c *PolymarketClient) Start() error {
	go c.connectionManager()
	return nil
}

// connectionManager handles reconnection logic with exponential backoff
func (c *PolymarketClient) connectionManager() {
	delay := pmReconnectBaseDelay

	for {
		select {
		case <-c.ctx.Done():
			c.logger.Info("polymarket connection manager stopping")
			return
		default:
		}

		err := c.connect()
		if err != nil {
			c.logger.Error("polymarket connection failed", "error", err)
			metrics.RecordWSReconnect("pm")
			metrics.SetWSConnectionStatus("pm", false)

			select {
			case <-c.ctx.Done():
				return
			case <-time.After(delay):
				// Exponential backoff
				delay *= 2
				if delay > pmMaxReconnectDelay {
					delay = pmMaxReconnectDelay
				}
			}
			continue
		}

		// Reset delay on successful connection
		delay = pmReconnectBaseDelay
		metrics.SetWSConnectionStatus("pm", true)

		// Wait for reconnect signal or context cancellation
		select {
		case <-c.reconnectCh:
			c.logger.Info("polymarket reconnect triggered")
		case <-c.ctx.Done():
			return
		}
	}
}

// connect establishes WebSocket connection and starts message handling
func (c *PolymarketClient) connect() error {
	c.logger.Info("connecting to polymarket", "url", polymarketWSURL)

	conn, _, err := websocket.DefaultDialer.Dial(polymarketWSURL, nil)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.connected = true
	c.mu.Unlock()

	// Subscribe to tokens in chunks
	if err := c.subscribe(); err != nil {
		conn.Close()
		return fmt.Errorf("subscribe failed: %w", err)
	}

	c.logger.Info("polymarket connected and subscribed", "tokens", len(c.tokenIDs))

	// Start ping/pong and read loops
	go c.pingLoop()
	go c.readLoop()

	return nil
}

// subscribe sends subscription messages in chunks
func (c *PolymarketClient) subscribe() error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()

	if conn == nil {
		return fmt.Errorf("no connection")
	}

	// Subscribe in chunks to avoid overwhelming the server
	for i := 0; i < len(c.tokenIDs); i += c.chunkSize {
		end := i + c.chunkSize
		if end > len(c.tokenIDs) {
			end = len(c.tokenIDs)
		}

		chunk := c.tokenIDs[i:end]
		msg := PMSubscribeMsg{
			Type:      "MARKET",
			AssetsIDs: chunk,
		}

		if err := conn.WriteJSON(msg); err != nil {
			return fmt.Errorf("write subscription: %w", err)
		}

		c.logger.Debug("polymarket subscribed chunk", "from", i, "to", end)

		// Small delay between chunks
		time.Sleep(100 * time.Millisecond)
	}

	return nil
}

// pingLoop sends periodic pings to keep connection alive
func (c *PolymarketClient) pingLoop() {
	ticker := time.NewTicker(pmPingInterval)
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
				c.logger.Error("polymarket ping failed", "error", err)
				c.triggerReconnect()
				return
			}
		}
	}
}

// readLoop reads messages from WebSocket
func (c *PolymarketClient) readLoop() {
	defer c.triggerReconnect()

	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()

	if conn == nil {
		return
	}

	for {
		if err := conn.SetReadDeadline(time.Now().Add(pmReadDeadline)); err != nil {
			c.logger.Error("polymarket set read deadline failed", "error", err)
			return
		}

		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.logger.Error("polymarket read error", "error", err)
			}
			return
		}

		c.handleMessage(message)
	}
}

// handleMessage processes incoming WebSocket messages
func (c *PolymarketClient) handleMessage(data []byte) {
	var msg PMMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		c.logger.Debug("polymarket unmarshal failed", "error", err)
		return
	}

	// Handle book updates and price changes
	if msg.EventType == "book" || msg.EventType == "price_change" {
		if msg.Asset != "" && msg.Price > 0 {
			// Determine if this is an ask (sell) or bid (buy)
			update := PMPriceUpdate{
				TokenID: msg.Asset,
			}

			if msg.Side == "sell" {
				update.Ask = msg.Price
			} else if msg.Side == "buy" {
				update.Bid = msg.Price
			}

			// Update internal state
			c.mu.Lock()
			if existing, ok := c.prices[msg.Asset]; ok {
				if update.Ask > 0 {
					existing.Ask = update.Ask
				}
				if update.Bid > 0 {
					existing.Bid = update.Bid
				}
			} else {
				c.prices[msg.Asset] = &update
			}
			c.mu.Unlock()

			metrics.RecordPriceUpdate("pm")

			// Send to channel
			select {
			case c.priceChan <- update:
			default:
				c.logger.Warn("polymarket price channel full, dropping update")
			}
		}
	}
}

// triggerReconnect signals the connection manager to reconnect
func (c *PolymarketClient) triggerReconnect() {
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.connected = false
	c.mu.Unlock()

	metrics.SetWSConnectionStatus("pm", false)

	select {
	case c.reconnectCh <- struct{}{}:
	default:
	}
}

// GetPriceChannel returns the channel for receiving price updates
func (c *PolymarketClient) GetPriceChannel() <-chan PMPriceUpdate {
	return c.priceChan
}

// GetPrice returns the current price for a token
func (c *PolymarketClient) GetPrice(tokenID string) (ask, bid float64, ok bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if p, found := c.prices[tokenID]; found {
		return p.Ask, p.Bid, true
	}
	return 0, 0, false
}

// IsConnected returns whether the client is currently connected
func (c *PolymarketClient) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

// Close gracefully closes the WebSocket connection
func (c *PolymarketClient) Close() error {
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
