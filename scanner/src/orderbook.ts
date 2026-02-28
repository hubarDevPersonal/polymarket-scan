import Decimal from "decimal.js";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface Level {
  price: Decimal;
  size: Decimal;
}

export interface RawLevel {
  price: string;
  size: string;
}

export interface BookSnapshot {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: RawLevel[];
  asks: RawLevel[];
  min_order_size?: string;
  tick_size?: string;
  last_trade_price?: string;
}

export interface OrderbookState {
  tokenId: string;
  bids: Map<string, Decimal>; // price string -> size
  asks: Map<string, Decimal>;
  lastTradePrice: Decimal | null;
  tickSize: Decimal;
  updatedAt: number;
  /** Number of delta updates received since last snapshot */
  deltaCount: number;
  /** Timestamp of last delta update (not snapshot) — shows real activity */
  lastDeltaAt: number;
  /** Timestamp of creation/first snapshot */
  createdAt: number;
}

export function createBook(tokenId: string): OrderbookState {
  const now = Date.now();
  return {
    tokenId,
    bids: new Map(),
    asks: new Map(),
    lastTradePrice: null,
    tickSize: new Decimal("0.01"),
    updatedAt: now,
    deltaCount: 0,
    lastDeltaAt: 0,
    createdAt: now,
  };
}

export function applySnapshot(
  book: OrderbookState,
  snap: BookSnapshot
): OrderbookState {
  book.bids.clear();
  book.asks.clear();

  for (const l of snap.bids) {
    const size = new Decimal(l.size);
    if (size.gt(0)) book.bids.set(l.price, size);
  }
  for (const l of snap.asks) {
    const size = new Decimal(l.size);
    if (size.gt(0)) book.asks.set(l.price, size);
  }

  if (snap.last_trade_price) {
    book.lastTradePrice = new Decimal(snap.last_trade_price);
  }
  if (snap.tick_size) {
    book.tickSize = new Decimal(snap.tick_size);
  }

  const now = Date.now();
  book.updatedAt = now;
  // Snapshot counts as activity — book was refreshed from server
  if (book.bids.size > 0 || book.asks.size > 0) {
    book.lastDeltaAt = now;
  }
  return book;
}

export interface DeltaUpdate {
  asset_id: string;
  price: string;
  size: string;
  side: "BUY" | "SELL" | "buy" | "sell";
  timestamp?: string;
}

export function applyDelta(
  book: OrderbookState,
  delta: DeltaUpdate
): OrderbookState {
  const side = delta.side.toUpperCase();
  const map = side === "BUY" ? book.bids : book.asks;
  const size = new Decimal(delta.size);

  if (size.isZero()) {
    map.delete(delta.price);
  } else {
    map.set(delta.price, size);
  }

  const now = Date.now();
  book.updatedAt = now;
  book.deltaCount++;
  book.lastDeltaAt = now;
  return book;
}

/** Get sorted levels: bids descending, asks ascending */
export function getSortedBids(book: OrderbookState): Level[] {
  return Array.from(book.bids.entries())
    .map(([p, s]) => ({ price: new Decimal(p), size: s }))
    .sort((a, b) => b.price.cmp(a.price));
}

export function getSortedAsks(book: OrderbookState): Level[] {
  return Array.from(book.asks.entries())
    .map(([p, s]) => ({ price: new Decimal(p), size: s }))
    .sort((a, b) => a.price.cmp(b.price));
}

export function getBestBid(book: OrderbookState): Decimal | null {
  const bids = getSortedBids(book);
  return bids.length > 0 ? bids[0].price : null;
}

export function getBestAsk(book: OrderbookState): Decimal | null {
  const asks = getSortedAsks(book);
  return asks.length > 0 ? asks[0].price : null;
}

export function getMid(book: OrderbookState): Decimal | null {
  const bb = getBestBid(book);
  const ba = getBestAsk(book);
  if (bb && ba) return bb.add(ba).div(2);
  return null;
}

export function getSpread(book: OrderbookState): Decimal | null {
  const bb = getBestBid(book);
  const ba = getBestAsk(book);
  if (bb && ba) return ba.sub(bb);
  return null;
}
