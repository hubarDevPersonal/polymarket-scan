const BINANCE_BASE = "https://api.binance.com/api/v3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CoinSymbol = "BTCUSDT" | "ETHUSDT" | "SOLUSDT";

export type KlineInterval = "1h" | "4h" | "1d" | "1w";

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
}

export interface TimeRange {
  startTime: number;
  endTime: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse one raw kline array into a typed Kline object. */
function parseKline(raw: unknown[]): Kline {
  return {
    openTime: Number(raw[0]),
    open: parseFloat(raw[1] as string),
    high: parseFloat(raw[2] as string),
    low: parseFloat(raw[3] as string),
    close: parseFloat(raw[4] as string),
    volume: parseFloat(raw[5] as string),
    closeTime: Number(raw[6]),
    quoteVolume: parseFloat(raw[7] as string),
    trades: Number(raw[8]),
    takerBuyBaseVolume: parseFloat(raw[9] as string),
    takerBuyQuoteVolume: parseFloat(raw[10] as string),
  };
}

/**
 * Return { startTime, endTime } in ms for a given calendar month.
 * startTime is 00:00:00.000 UTC on the 1st; endTime is 23:59:59.999 UTC
 * on the last day of the month.
 */
export function getMonthRange(year: number, month: number): TimeRange {
  const startTime = Date.UTC(year, month - 1, 1);
  const endTime = Date.UTC(year, month, 1) - 1;
  return { startTime, endTime };
}

/**
 * Return { startTime, endTime } for the ISO week (Mon-Sun) containing
 * the supplied date. Times are in UTC ms.
 */
export function getWeekRange(date: Date): TimeRange {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  // Shift so Monday = 0
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  const startTime = d.getTime(); // Monday 00:00:00.000 UTC
  const endTime = startTime + 7 * 24 * 60 * 60 * 1000 - 1; // Sunday 23:59:59.999 UTC
  return { startTime, endTime };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Fetch kline / candlestick data from Binance.
 *
 * @param symbol   - Trading pair, e.g. "BTCUSDT"
 * @param interval - Candle interval, e.g. "1h"
 * @param startTime - Start time in ms (optional)
 * @param endTime   - End time in ms (optional)
 * @param limit     - Number of candles, default 500, max 1000 (optional)
 */
export async function fetchKlines(
  symbol: CoinSymbol,
  interval: KlineInterval,
  startTime?: number,
  endTime?: number,
  limit?: number,
): Promise<Kline[]> {
  const params = new URLSearchParams({
    symbol,
    interval,
  });

  if (startTime !== undefined) params.set("startTime", String(startTime));
  if (endTime !== undefined) params.set("endTime", String(endTime));
  if (limit !== undefined) params.set("limit", String(Math.min(limit, 1000)));

  const url = `${BINANCE_BASE}/klines?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines failed for ${symbol} ${interval}: ${res.status}`);

  const raw = (await res.json()) as unknown[][];
  return raw.map(parseKline);
}
