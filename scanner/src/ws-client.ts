import WebSocket from "ws";
import { EventEmitter } from "events";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL = 30_000;
const STALL_TIMEOUT = 90_000; // no messages for 90s → stall
const RECONNECT_BASE = 2_000;
const RECONNECT_MAX = 60_000;

export interface WSBookEvent {
  event_type: "book";
  asset_id: string;
  market: string;
  timestamp: string;
  hash: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
}

export interface WSPriceChangeEvent {
  event_type: "price_change";
  asset_id: string;
  price: string;
  size: string;
  side: string;
  timestamp: string;
}

export interface WSLastTradeEvent {
  event_type: "last_trade_price";
  asset_id: string;
  price: string;
  size: string;
  side: string;
  timestamp: string;
}

export type WSEvent = WSBookEvent | WSPriceChangeEvent | WSLastTradeEvent | { event_type: string; [key: string]: any };

export class PolymarketWS extends EventEmitter {
  private ws: WebSocket | null = null;
  private tokenIds: string[] = [];
  private pingTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_BASE;
  private shouldRun = false;
  private connected = false;
  private lastMessageAt = 0;
  private messageCount = 0;

  subscribe(tokenIds: string[]) {
    this.tokenIds = tokenIds;
    if (this.ws && this.connected) {
      this.sendSubscription();
    }
  }

  start() {
    this.shouldRun = true;
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    this.cleanup();
  }

  isConnected() {
    return this.connected;
  }

  private connect() {
    if (!this.shouldRun) return;

    console.log(`[ws] connecting to ${WS_URL}`);
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      console.log("[ws] connected");
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE;
      this.emit("connected");

      this.startPing();
      this.startStallDetection();

      if (this.tokenIds.length > 0) {
        this.sendSubscription();
      }
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const raw = data.toString();
        // Can be a single message or array
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
          for (const msg of parsed) {
            this.handleMessage(msg);
          }
        } else {
          this.handleMessage(parsed);
        }
      } catch (err) {
        // ignore parse errors for pong frames etc.
      }
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[ws] closed: ${code} ${reason.toString()}`);
      this.connected = false;
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error(`[ws] error: ${err.message}`);
      this.connected = false;
    });
  }

  private handleMessage(msg: any) {
    if (!msg || !msg.event_type) return;

    this.lastMessageAt = Date.now();
    this.messageCount++;
    this.resetStallTimer();

    // Emit typed events
    this.emit("message", msg as WSEvent);

    switch (msg.event_type) {
      case "book":
        this.emit("book", msg as WSBookEvent);
        break;
      case "price_change":
        this.emit("price_change", msg as WSPriceChangeEvent);
        break;
      case "last_trade_price":
        this.emit("last_trade", msg as WSLastTradeEvent);
        break;
    }
  }

  private sendSubscription() {
    if (!this.ws || !this.connected) return;

    // Subscribe in chunks of 50 to avoid overload
    const chunkSize = 50;
    for (let i = 0; i < this.tokenIds.length; i += chunkSize) {
      const chunk = this.tokenIds.slice(i, i + chunkSize);
      const msg = {
        assets_ids: chunk,
        type: "market",
      };

      this.ws.send(JSON.stringify(msg));
      console.log(`[ws] subscribed to ${chunk.length} tokens (chunk ${Math.floor(i / chunkSize) + 1})`);
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.connected) {
        try {
          this.ws.ping();
        } catch {
          this.scheduleReconnect();
        }
      }
    }, PING_INTERVAL);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startStallDetection() {
    this.stopStallDetection();
    this.lastMessageAt = Date.now();
    this.stallTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastMessageAt > STALL_TIMEOUT) {
        console.warn(`[ws] stall detected (no messages for ${STALL_TIMEOUT / 1000}s), reconnecting`);
        this.emit("stall");
        this.scheduleReconnect();
      }
    }, STALL_TIMEOUT / 2);
  }

  private stopStallDetection() {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private resetStallTimer() {
    // Just update the timestamp; the interval check handles the rest
    this.lastMessageAt = Date.now();
  }

  getStats() {
    return {
      connected: this.connected,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      subscribedTokens: this.tokenIds.length,
    };
  }

  private cleanup() {
    this.stopPing();
    this.stopStallDetection();
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect() {
    if (!this.shouldRun) return;

    this.cleanup();
    console.log(`[ws] reconnecting in ${this.reconnectDelay}ms`);

    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
  }
}
