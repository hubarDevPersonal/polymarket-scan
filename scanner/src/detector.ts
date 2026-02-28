import { EventEmitter } from "events";
import Decimal from "decimal.js";
import {
  OrderbookState,
  getBestBid,
  getBestAsk,
  getMid,
  getSpread,
  getSortedBids,
  getSortedAsks,
} from "./orderbook";

// ─── Config ────────────────────────────────────────────────────────

export interface DetectorConfig {
  /** Minimum spread in bps to trigger an opportunity */
  spreadThresholdBps: number;
  /** Minimum total depth ($) within `depthBps` of touch on EACH side */
  minDepthUsd: number;
  /** How far from touch to measure depth (bps) */
  depthBps: number;
  /** Spread must persist for this many consecutive checks */
  stabilityChecks: number;
  /** Interval between stability checks (ms) */
  stabilityIntervalMs: number;
  /** Minimum trades in the last N seconds to consider market "alive" */
  minRecentTrades: number;
  /** Window for recent-trades check (ms) */
  tradeWindowMs: number;
  /** Cooldown before re-alerting on the same token (ms) */
  cooldownMs: number;

  // ── New quality filters ────────────────────────────────────────

  /** Minimum bid levels (orders) in the book — reject 1-order books */
  minBidLevels: number;
  /** Minimum ask levels (orders) in the book */
  minAskLevels: number;
  /** Reject best bid below this price (filters resolved markets like 0.001) */
  minBidPrice: number;
  /** Reject best ask above this price (filters resolved markets like 0.999) */
  maxAskPrice: number;
  /** Minimum delta updates in the last activityWindowMs (book must be alive) */
  minBookUpdates: number;
  /** Window for book-update activity check (ms) */
  activityWindowMs: number;
}

export const DEFAULT_CONFIG: DetectorConfig = {
  spreadThresholdBps: 200,
  minDepthUsd: 50,
  depthBps: 200,
  stabilityChecks: 3,
  stabilityIntervalMs: 2000,
  minRecentTrades: 0,
  tradeWindowMs: 300_000, // 5 min
  cooldownMs: 60_000,

  // Quality filters
  minBidLevels: 2,
  minAskLevels: 2,
  minBidPrice: 0.02,
  maxAskPrice: 0.98,
  minBookUpdates: 0,
  activityWindowMs: 1_800_000, // 30 min — book must have been updated in last 30 min
};

// ─── Types ─────────────────────────────────────────────────────────

export type OpportunityStatus = "new" | "stable" | "vanished" | "thinned";

export type RejectReason =
  | "empty_book"
  | "thin_bids"
  | "thin_asks"
  | "low_bid_depth"
  | "low_ask_depth"
  | "resolved_low"
  | "resolved_high"
  | "no_activity"
  | "spread_narrow";

export interface Opportunity {
  tokenId: string;
  status: OpportunityStatus;
  spreadBps: number;
  bestBid: string;
  bestAsk: string;
  mid: string;
  bidDepthUsd: number;
  askDepthUsd: number;
  bidLevels: number;
  askLevels: number;
  stabilityCount: number;
  recentTrades: number;
  bookUpdates: number;
  detectedAt: number;
  updatedAt: number;
  /** Human-readable label from market metadata */
  label?: string;
}

export interface TradeRecord {
  tokenId: string;
  price: string;
  size: string;
  side: string;
  timestamp: number;
}

// ─── Internal tracker per token ────────────────────────────────────

interface TokenTracker {
  /** Consecutive checks where spread exceeded threshold */
  stableCount: number;
  /** Whether we already emitted a "stable" alert */
  alertedStable: boolean;
  /** Timestamp of last alert (for cooldown) */
  lastAlertAt: number;
  /** Previous spread bps for delta check */
  prevSpreadBps: number | null;
  /** Recent trades ring buffer */
  trades: TradeRecord[];
}

// ─── Detector ──────────────────────────────────────────────────────

export class OpportunityDetector extends EventEmitter {
  private config: DetectorConfig;
  private trackers = new Map<string, TokenTracker>();
  private activeOpportunities = new Map<string, Opportunity>();
  private labels = new Map<string, string>(); // tokenId -> market question

  constructor(config: Partial<DetectorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): DetectorConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<DetectorConfig>) {
    Object.assign(this.config, patch);
    this.emit("config_changed", this.config);
  }

  setLabel(tokenId: string, label: string) {
    this.labels.set(tokenId, label);
  }

  /** Record a trade for activity tracking */
  recordTrade(trade: TradeRecord) {
    let tracker = this.trackers.get(trade.tokenId);
    if (!tracker) {
      tracker = this.newTracker();
      this.trackers.set(trade.tokenId, tracker);
    }
    tracker.trades.push(trade);

    // Prune old trades
    const cutoff = Date.now() - this.config.tradeWindowMs;
    tracker.trades = tracker.trades.filter((t) => t.timestamp > cutoff);
  }

  /** Evaluate a book for opportunities. Call on every book update. */
  evaluate(book: OrderbookState): Opportunity | null {
    const tokenId = book.tokenId;
    const bb = getBestBid(book);
    const ba = getBestAsk(book);
    const mid = getMid(book);
    const spread = getSpread(book);

    // ── Gate 1: Must have two-sided book ──
    if (!bb || !ba || !mid || !spread || mid.isZero()) {
      this.maybeVanish(tokenId, "empty_book");
      return null;
    }

    // ── Gate 2: Level count — reject 1-order "dust" books ──
    const bidLevels = book.bids.size;
    const askLevels = book.asks.size;

    if (bidLevels < this.config.minBidLevels) {
      this.maybeVanish(tokenId, "thin_bids");
      return null;
    }
    if (askLevels < this.config.minAskLevels) {
      this.maybeVanish(tokenId, "thin_asks");
      return null;
    }

    // ── Gate 3: Price range — reject resolved markets ──
    const bbNum = bb.toNumber();
    const baNum = ba.toNumber();

    if (bbNum < this.config.minBidPrice) {
      this.maybeVanish(tokenId, "resolved_low");
      return null;
    }
    if (baNum > this.config.maxAskPrice) {
      this.maybeVanish(tokenId, "resolved_high");
      return null;
    }

    // ── Gate 4: Book activity — must have been updated recently ──
    const now = Date.now();
    const timeSinceUpdate = book.lastDeltaAt > 0
      ? now - book.lastDeltaAt
      : now - book.createdAt;

    if (timeSinceUpdate > this.config.activityWindowMs) {
      this.maybeVanish(tokenId, "no_activity");
      return null;
    }

    // ── Gate 5: Spread threshold ──
    const spreadBps = spread.div(mid).mul(10000).toNumber();

    if (spreadBps < this.config.spreadThresholdBps) {
      this.maybeVanish(tokenId, "spread_narrow");
      return null;
    }

    // ── Gate 6: Depth — meaningful $ on each side ──
    const bidDepthUsd = this.depthNearTouch(book, "bids", bb);
    const askDepthUsd = this.depthNearTouch(book, "asks", ba);

    if (bidDepthUsd < this.config.minDepthUsd) {
      this.maybeVanish(tokenId, "low_bid_depth");
      return null;
    }
    if (askDepthUsd < this.config.minDepthUsd) {
      this.maybeVanish(tokenId, "low_ask_depth");
      return null;
    }

    // ── Gate 7: Trade activity (optional) ──
    let tracker = this.trackers.get(tokenId);
    if (!tracker) {
      tracker = this.newTracker();
      this.trackers.set(tokenId, tracker);
    }

    const recentTrades = tracker.trades.filter(
      (t) => t.timestamp > now - this.config.tradeWindowMs
    ).length;

    if (recentTrades < this.config.minRecentTrades) {
      this.maybeVanish(tokenId, "no_activity");
      return null;
    }

    // ── ALL GATES PASSED — real opportunity ──

    tracker.stableCount++;

    const opp: Opportunity = {
      tokenId,
      status:
        tracker.stableCount >= this.config.stabilityChecks
          ? "stable"
          : "new",
      spreadBps: Math.round(spreadBps),
      bestBid: bb.toFixed(4),
      bestAsk: ba.toFixed(4),
      mid: mid.toFixed(4),
      bidDepthUsd,
      askDepthUsd,
      bidLevels,
      askLevels,
      stabilityCount: tracker.stableCount,
      recentTrades,
      bookUpdates: book.deltaCount,
      detectedAt:
        this.activeOpportunities.get(tokenId)?.detectedAt || now,
      updatedAt: now,
      label: this.labels.get(tokenId),
    };

    const prev = this.activeOpportunities.get(tokenId);
    this.activeOpportunities.set(tokenId, opp);

    // Emit events based on state transitions
    if (!prev) {
      this.emit("opportunity", opp);
      tracker.lastAlertAt = now;
    } else if (opp.status === "stable" && !tracker.alertedStable) {
      tracker.alertedStable = true;
      this.emit("opportunity_stable", opp);
      tracker.lastAlertAt = now;
    } else if (
      now - tracker.lastAlertAt > this.config.cooldownMs &&
      opp.status === "stable"
    ) {
      // Periodic re-alert
      this.emit("opportunity_update", opp);
      tracker.lastAlertAt = now;
    }

    tracker.prevSpreadBps = spreadBps;
    return opp;
  }

  private maybeVanish(tokenId: string, reason: RejectReason) {
    const prev = this.activeOpportunities.get(tokenId);
    if (prev) {
      this.activeOpportunities.delete(tokenId);
      const vanished: Opportunity = {
        ...prev,
        status: reason.startsWith("thin") || reason.startsWith("low")
          ? "thinned"
          : "vanished",
        updatedAt: Date.now(),
      };
      this.emit("opportunity_vanished", vanished);
    }

    // Reset tracker
    const tracker = this.trackers.get(tokenId);
    if (tracker) {
      tracker.stableCount = 0;
      tracker.alertedStable = false;
    }
  }

  /** Compute total notional depth within `depthBps` of the reference price */
  private depthNearTouch(
    book: OrderbookState,
    side: "bids" | "asks",
    refPrice: Decimal
  ): number {
    const offset = refPrice.mul(this.config.depthBps).div(10000);
    let total = new Decimal(0);

    const map = side === "bids" ? book.bids : book.asks;
    for (const [priceStr, size] of map) {
      const price = new Decimal(priceStr);
      if (side === "bids" && price.gte(refPrice.sub(offset))) {
        total = total.add(size.mul(price));
      } else if (side === "asks" && price.lte(refPrice.add(offset))) {
        total = total.add(size.mul(price));
      }
    }

    return total.toNumber();
  }

  getActiveOpportunities(): Opportunity[] {
    return Array.from(this.activeOpportunities.values()).sort(
      (a, b) => b.spreadBps - a.spreadBps
    );
  }

  getOpportunity(tokenId: string): Opportunity | undefined {
    return this.activeOpportunities.get(tokenId);
  }

  private newTracker(): TokenTracker {
    return {
      stableCount: 0,
      alertedStable: false,
      lastAlertAt: 0,
      prevSpreadBps: null,
      trades: [],
    };
  }
}
