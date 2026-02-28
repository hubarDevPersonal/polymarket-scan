import { GammaEvent, GammaMarket } from "./gamma";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface PricePoint {
  t: number;
  p: number;
}

export interface OutcomeHistory {
  marketId: string;
  question: string;
  outcome: string;
  tokenId: string;
  finalPrice: number;
  history: PricePoint[];
}

export interface HistoricalEvent {
  eventId: string;
  title: string;
  endDate: string;
  period: string; // e.g. "2024-12" for monthly or "2024-W48" for weekly
  coin: string;
  outcomes: OutcomeHistory[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Regex patterns that identify price-related prediction markets */
const PRICE_PATTERNS = [
  /hit price/i,
  /above/i,
  /below/i,
  /\$[\d,]+/i,
  /reach \$/i,
  /will .+ hit/i,
  /price.*\d/i,
  /\d+k/i,
];

/** Compute ISO week number from a Date */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Derive a period label from an ISO date string */
function derivePeriod(endDate: string, period: "weekly" | "monthly"): string {
  const d = new Date(endDate);
  if (period === "monthly") {
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${d.getUTCFullYear()}-${month}`;
  }
  const week = String(getISOWeek(d)).padStart(2, "0");
  return `${d.getUTCFullYear()}-W${week}`;
}

// ---------------------------------------------------------------------------
// Fetch resolved crypto events
// ---------------------------------------------------------------------------

/**
 * Fetch crypto events (both open and closed) filtered by coin and price patterns.
 * The Gamma API's `closed=true` filter ignores tag/order params, so we fetch all
 * events and filter client-side.
 */
export interface DateFilter {
  year: number;
  month: number; // 1-12
}

const MONTH_NAMES = [
  "", "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const COIN_ALIASES: Record<string, string[]> = {
  BTC: ["BTC", "BITCOIN"],
  ETH: ["ETH", "ETHEREUM"],
  SOL: ["SOL", "SOLANA"],
};

/** Check if a GammaEvent matches coin + price pattern filters */
function matchesCoinAndPrice(e: GammaEvent, aliases: string[]): boolean {
  const text = `${e.title} ${e.slug}`.toUpperCase();
  const mentionsCoin = aliases.some((a) => text.includes(a));
  const matchesPrice = PRICE_PATTERNS.some((p) => p.test(text));
  return mentionsCoin && matchesPrice;
}

/** Check if event belongs to the target month by title or date range */
function matchesMonth(
  e: GammaEvent,
  dateFilter: DateFilter,
  monthStart: Date,
  monthEnd: Date,
): boolean {
  const title = (e.title || "").toLowerCase();

  // Check if title mentions any month name
  const titleMonthIdx = MONTH_NAMES.findIndex(
    (m, i) => i > 0 && title.includes(m),
  );

  if (titleMonthIdx > 0) {
    // Title explicitly names a month — only match if it's the selected month
    const matchesM = titleMonthIdx === dateFilter.month;
    const matchesY =
      title.includes(String(dateFilter.year)) || !title.match(/20\d\d/);
    return matchesM && matchesY;
  }

  // No month in title — fall back to date range matching
  const ed = e.endDate ? new Date(e.endDate) : null;
  const sd = e.startDate ? new Date(e.startDate) : null;
  if (
    (ed && ed >= monthStart && ed < monthEnd) ||
    (sd && sd >= monthStart && sd < monthEnd)
  ) {
    return true;
  }
  return false;
}

/** Fetch pages from a Gamma API URL, filtering by coin/price and optionally by month */
async function fetchFilteredPages(
  baseUrl: string,
  pages: number,
  pageSize: number,
  aliases: string[],
  dateFilter?: DateFilter,
  monthStart?: Date,
  monthEnd?: Date,
): Promise<GammaEvent[]> {
  const matched: GammaEvent[] = [];

  for (let page = 0; page < pages; page++) {
    const offset = page * pageSize;
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}limit=${pageSize}&offset=${offset}`;
    console.log(`[history] fetching: ${url}`);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[history] page ${page} failed: ${res.status}`);
        break;
      }

      const events = (await res.json()) as GammaEvent[];
      if (events.length === 0) break;

      for (const e of events) {
        if (!matchesCoinAndPrice(e, aliases)) continue;
        if (dateFilter && monthStart && monthEnd) {
          if (!matchesMonth(e, dateFilter, monthStart, monthEnd)) continue;
        }
        matched.push(e);
      }
    } catch (err: any) {
      console.warn(`[history] page ${page} error: ${err.message}`);
      break;
    }
  }

  return matched;
}

export async function fetchResolvedCryptoEvents(
  coin: string,
  limit = 100,
  dateFilter?: DateFilter,
): Promise<GammaEvent[]> {
  const coinUpper = coin.toUpperCase();
  const aliases = COIN_ALIASES[coinUpper] || [coinUpper];
  const pageSize = 100;

  // Date range for the requested month (with buffer for late resolutions)
  let monthStart: Date | undefined;
  let monthEnd: Date | undefined;
  if (dateFilter) {
    // Start a few days before the month to catch events that straddle boundaries
    monthStart = new Date(Date.UTC(dateFilter.year, dateFilter.month - 1, 1));
    // 3-day buffer past month end
    monthEnd = new Date(Date.UTC(dateFilter.year, dateFilter.month, 3));
  }

  const seenIds = new Set<string>();
  const allMatched: GammaEvent[] = [];

  const addUnique = (events: GammaEvent[]) => {
    for (const e of events) {
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        allMatched.push(e);
      }
    }
  };

  // 1) Always fetch active events (by volume) — covers current/future months
  const activeResults = await fetchFilteredPages(
    `${GAMMA_BASE}/events?order=volume24hr&ascending=false`,
    3,
    pageSize,
    aliases,
    dateFilter,
    monthStart,
    monthEnd,
  );
  addUnique(activeResults);

  // 2) If date filter is set, also fetch closed events within the date range
  //    Gamma API supports end_date_min / end_date_max for closed events
  if (dateFilter && monthStart && monthEnd) {
    // Widen the API date window a bit to catch edge cases
    const apiDateMin = new Date(Date.UTC(dateFilter.year, dateFilter.month - 1, 1) - 7 * 86400000);
    const apiDateMax = new Date(Date.UTC(dateFilter.year, dateFilter.month, 7));
    const minStr = apiDateMin.toISOString().slice(0, 10);
    const maxStr = apiDateMax.toISOString().slice(0, 10);

    const closedResults = await fetchFilteredPages(
      `${GAMMA_BASE}/events?closed=true&end_date_min=${minStr}&end_date_max=${maxStr}&order=volume&ascending=false`,
      3,
      pageSize,
      aliases,
      dateFilter,
      monthStart,
      monthEnd,
    );
    addUnique(closedResults);
  }

  console.log(
    `[history] found ${allMatched.length} ${coinUpper} events` +
      (dateFilter ? ` for ${dateFilter.year}-${dateFilter.month}` : " across pages"),
  );
  return allMatched.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Fetch price history for a single CLOB token
// ---------------------------------------------------------------------------

/** Fetch a single chunk of price history from CLOB */
async function fetchPriceHistoryChunk(
  tokenId: string,
  startTs?: number,
  endTs?: number,
  fidelity?: number,
): Promise<PricePoint[]> {
  let url = `${CLOB_BASE}/prices-history?market=${tokenId}&interval=all`;
  if (startTs !== undefined) url += `&startTs=${startTs}`;
  if (endTs !== undefined) url += `&endTs=${endTs}`;
  if (fidelity !== undefined) url += `&fidelity=${fidelity}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[history] price history chunk failed for ${tokenId}: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { history: { t: number; p: string }[] };
  if (!data.history || !Array.isArray(data.history)) {
    return [];
  }

  return data.history.map((point) => ({
    t: point.t,
    p: parseFloat(point.p),
  }));
}

const CHUNK_DAYS = 4;
const CHUNK_MS = CHUNK_DAYS * 86400;

/**
 * Fetch full price history for a CLOB token by paginating in 4-day chunks.
 * The CLOB API caps results per request (~575 pts), so we need to split
 * the time range into chunks and merge results.
 */
export async function fetchPriceHistory(
  tokenId: string,
  startTs?: number,
  endTs?: number,
  interval?: string,
): Promise<PricePoint[]> {
  // If we have a time range, paginate in 4-day chunks with fidelity=10
  if (startTs && endTs) {
    const allPoints: PricePoint[] = [];
    let cursor = startTs;

    while (cursor < endTs) {
      const chunkEnd = Math.min(cursor + CHUNK_MS, endTs);
      const chunk = await fetchPriceHistoryChunk(tokenId, cursor, chunkEnd, 10);
      allPoints.push(...chunk);
      cursor = chunkEnd;
    }

    // Deduplicate by timestamp (chunks may overlap at boundaries)
    const seen = new Set<number>();
    const deduped = allPoints.filter((p) => {
      if (seen.has(p.t)) return false;
      seen.add(p.t);
      return true;
    });

    console.log(
      `[history] fetched ${deduped.length} price points for ${tokenId.slice(-12)}... (${Math.ceil((endTs - startTs) / CHUNK_MS)} chunks)`,
    );
    return deduped.sort((a, b) => a.t - b.t);
  }

  // Fallback: single request (for backward compat)
  console.log(`[history] fetching price history (single): ${tokenId.slice(-12)}...`);
  return fetchPriceHistoryChunk(tokenId);
}

// ---------------------------------------------------------------------------
// Build full historical events with price data
// ---------------------------------------------------------------------------

/** Parse a single market into OutcomeHistory entries (without price history yet) */
function parseMarketOutcomeStubs(market: GammaMarket): Omit<OutcomeHistory, "history">[] {
  const stubs: Omit<OutcomeHistory, "history">[] = [];

  try {
    const outcomes: string[] = JSON.parse(market.outcomes || "[]");
    const prices: number[] = JSON.parse(market.outcomePrices || "[]");
    const tokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");

    for (let i = 0; i < outcomes.length; i++) {
      stubs.push({
        marketId: market.id,
        question: market.question,
        outcome: outcomes[i],
        tokenId: tokenIds[i] || "",
        finalPrice: prices[i] || 0,
      });
    }
  } catch {
    // skip malformed market data
  }

  return stubs;
}

/**
 * Fetch resolved events for a coin together with per-outcome price histories.
 * Events are annotated with a period label (weekly or monthly) based on endDate.
 */
export async function fetchHistoricalEventsWithPrices(
  coin: string,
  period: "weekly" | "monthly",
): Promise<HistoricalEvent[]> {
  const events = await fetchResolvedCryptoEvents(coin);
  console.log(`[history] found ${events.length} resolved events for ${coin}`);

  const results: HistoricalEvent[] = [];

  for (const event of events) {
    const outcomeStubs: Omit<OutcomeHistory, "history">[] = [];
    for (const market of event.markets) {
      outcomeStubs.push(...parseMarketOutcomeStubs(market));
    }

    if (outcomeStubs.length === 0) continue;

    // Fetch price histories in parallel for all outcome tokens in this event
    const histories = await Promise.all(
      outcomeStubs.map((stub) =>
        stub.tokenId
          ? fetchPriceHistory(stub.tokenId).catch((err) => {
              console.warn(`[history] price history error for ${stub.tokenId}: ${err.message}`);
              return [] as PricePoint[];
            })
          : Promise.resolve([] as PricePoint[]),
      ),
    );

    const outcomes: OutcomeHistory[] = outcomeStubs.map((stub, i) => ({
      ...stub,
      history: histories[i],
    }));

    results.push({
      eventId: event.id,
      title: event.title,
      endDate: event.endDate,
      period: derivePeriod(event.endDate, period),
      coin: coin.toUpperCase(),
      outcomes,
    });
  }

  console.log(
    `[history] built ${results.length} historical events with price data for ${coin}`,
  );

  return results;
}
