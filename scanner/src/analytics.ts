import Decimal from "decimal.js";
import {
  OrderbookState,
  getSortedBids,
  getSortedAsks,
  getBestBid,
  getBestAsk,
  getMid,
  getSpread,
  Level,
} from "./orderbook";

export interface TopOfBook {
  bestBid: string | null;
  bestAsk: string | null;
  mid: string | null;
  spread: string | null;
  spreadBps: string | null;
  lastTrade: string | null;
}

export interface DepthInfo {
  bidDepth: string;
  askDepth: string;
  totalDepth: string;
  imbalance: string; // (bidDepth - askDepth) / totalDepth, range [-1, 1]
}

export interface SlippageResult {
  quantity: string;
  avgFillPrice: string;
  slippageFromMid: string;
  slippageFromTouch: string;
  filled: string;
  levels: number;
}

export function computeTopOfBook(book: OrderbookState): TopOfBook {
  const bb = getBestBid(book);
  const ba = getBestAsk(book);
  const mid = getMid(book);
  const spread = getSpread(book);

  let spreadBps: Decimal | null = null;
  if (spread && mid && !mid.isZero()) {
    spreadBps = spread.div(mid).mul(10000);
  }

  return {
    bestBid: bb?.toFixed(4) ?? null,
    bestAsk: ba?.toFixed(4) ?? null,
    mid: mid?.toFixed(4) ?? null,
    spread: spread?.toFixed(4) ?? null,
    spreadBps: spreadBps?.toFixed(1) ?? null,
    lastTrade: book.lastTradePrice?.toFixed(4) ?? null,
  };
}

/** Compute depth within `bps` basis points of mid price */
export function computeDepthAtBps(
  book: OrderbookState,
  bps: number
): DepthInfo {
  const mid = getMid(book);
  if (!mid || mid.isZero()) {
    return { bidDepth: "0", askDepth: "0", totalDepth: "0", imbalance: "0" };
  }

  const offset = mid.mul(bps).div(10000);
  const bidFloor = mid.sub(offset);
  const askCeil = mid.add(offset);

  let bidDepth = new Decimal(0);
  for (const [priceStr, size] of book.bids) {
    const price = new Decimal(priceStr);
    if (price.gte(bidFloor)) {
      bidDepth = bidDepth.add(size.mul(price));
    }
  }

  let askDepth = new Decimal(0);
  for (const [priceStr, size] of book.asks) {
    const price = new Decimal(priceStr);
    if (price.lte(askCeil)) {
      askDepth = askDepth.add(size.mul(price));
    }
  }

  const totalDepth = bidDepth.add(askDepth);
  const imbalance = totalDepth.isZero()
    ? new Decimal(0)
    : bidDepth.sub(askDepth).div(totalDepth);

  return {
    bidDepth: bidDepth.toFixed(2),
    askDepth: askDepth.toFixed(2),
    totalDepth: totalDepth.toFixed(2),
    imbalance: imbalance.toFixed(4),
  };
}

/** Walk the book to estimate slippage for a given notional quantity (in $) */
export function estimateSlippage(
  book: OrderbookState,
  side: "BUY" | "SELL",
  notionalQty: number
): SlippageResult {
  const levels: Level[] =
    side === "BUY" ? getSortedAsks(book) : getSortedBids(book);

  let remaining = new Decimal(notionalQty);
  let totalCost = new Decimal(0);
  let totalFilled = new Decimal(0);
  let levelsUsed = 0;

  for (const level of levels) {
    if (remaining.lte(0)) break;

    const levelNotional = level.price.mul(level.size);
    const take = Decimal.min(remaining, levelNotional);
    const qty = take.div(level.price);

    totalCost = totalCost.add(take);
    totalFilled = totalFilled.add(qty);
    remaining = remaining.sub(take);
    levelsUsed++;
  }

  if (totalFilled.isZero()) {
    return {
      quantity: notionalQty.toString(),
      avgFillPrice: "N/A",
      slippageFromMid: "N/A",
      slippageFromTouch: "N/A",
      filled: "0",
      levels: 0,
    };
  }

  const avgFill = totalCost.div(totalFilled);
  const mid = getMid(book);
  const touch =
    side === "BUY" ? getBestAsk(book) : getBestBid(book);

  let slipMid = "N/A";
  let slipTouch = "N/A";

  if (mid && !mid.isZero()) {
    const s = side === "BUY"
      ? avgFill.sub(mid).div(mid).mul(10000)
      : mid.sub(avgFill).div(mid).mul(10000);
    slipMid = s.toFixed(1) + " bps";
  }

  if (touch && !touch.isZero()) {
    const s = side === "BUY"
      ? avgFill.sub(touch).div(touch).mul(10000)
      : touch.sub(avgFill).div(touch).mul(10000);
    slipTouch = s.toFixed(1) + " bps";
  }

  return {
    quantity: `$${notionalQty}`,
    avgFillPrice: avgFill.toFixed(4),
    slippageFromMid: slipMid,
    slippageFromTouch: slipTouch,
    filled: totalCost.toFixed(2),
    levels: levelsUsed,
  };
}

/** Full analytics snapshot for a book */
export interface BookAnalytics {
  tokenId: string;
  topOfBook: TopOfBook;
  depth10bps: DepthInfo;
  depth25bps: DepthInfo;
  depth50bps: DepthInfo;
  slippage: SlippageResult[];
  bidLevels: number;
  askLevels: number;
  updatedAt: number;
}

export function computeAnalytics(book: OrderbookState): BookAnalytics {
  return {
    tokenId: book.tokenId,
    topOfBook: computeTopOfBook(book),
    depth10bps: computeDepthAtBps(book, 10),
    depth25bps: computeDepthAtBps(book, 25),
    depth50bps: computeDepthAtBps(book, 50),
    slippage: [100, 500, 1000, 5000].map((q) =>
      estimateSlippage(book, "BUY", q)
    ),
    bidLevels: book.bids.size,
    askLevels: book.asks.size,
    updatedAt: book.updatedAt,
  };
}
