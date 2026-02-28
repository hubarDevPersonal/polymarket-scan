import { ClickHouseDb } from "./connection";
import {
  fetchResolvedCryptoEvents,
  fetchPriceHistory,
  DateFilter,
  PricePoint,
} from "../history";
import { GammaEvent, GammaMarket } from "../gamma";
import {
  fetchKlines,
  getMonthRange,
  CoinSymbol,
  Kline,
} from "../binance";

// ─── Types ───────────────────────────────────────────────────────

export interface SyncOptions {
  coin: string; // BTC, ETH, SOL
  year: number;
  month: number; // 1-12
  force?: boolean; // re-fetch even if already synced
}

export interface SyncProgress {
  phase: string;
  detail: string;
  eventsTotal: number;
  eventsCurrent: number;
  tokensTotal: number;
  tokensCurrent: number;
  pricePointsInserted: number;
  klinesInserted: number;
}

export interface SyncResult {
  syncId: number;
  status: "completed" | "failed";
  eventsCount: number;
  marketsCount: number;
  pricePointsCount: number;
  klinesCount: number;
  durationMs: number;
  error?: string;
}

interface SyncLogRow {
  id: number;
  status: string;
  completed_at: string | null;
}

// ─── Constants ───────────────────────────────────────────────────

const COIN_SYMBOLS: Record<string, CoinSymbol> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
};

const TOKEN_FETCH_DELAY_MS = 200;
const PRICE_HISTORY_BATCH = 5000;

// ─── HistorySync ─────────────────────────────────────────────────

export class HistorySync {
  private db: ClickHouseDb;
  private running = false;

  constructor(db: ClickHouseDb) {
    this.db = db;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Check if a completed sync exists for this coin/month */
  async getLastSync(
    coin: string,
    year: number,
    month: number,
  ): Promise<SyncLogRow | null> {
    const rows = await this.db.query<SyncLogRow>(
      `SELECT id, status, completed_at
       FROM scanner.sync_log
       WHERE coin = '${esc(coin)}' AND year = ${year} AND month = ${month}
         AND status = 'completed'
       ORDER BY started_at DESC
       LIMIT 1`,
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /** Get all sync log entries */
  async getSyncLog(): Promise<any[]> {
    return this.db.query(
      `SELECT * FROM scanner.sync_log ORDER BY started_at DESC LIMIT 50`,
    );
  }

  /** Main sync method */
  async sync(
    opts: SyncOptions,
    onProgress?: (p: SyncProgress) => void,
  ): Promise<SyncResult> {
    if (this.running) {
      throw new Error("Sync already in progress");
    }

    const startTime = Date.now();
    this.running = true;

    const progress: SyncProgress = {
      phase: "init",
      detail: "",
      eventsTotal: 0,
      eventsCurrent: 0,
      tokensTotal: 0,
      tokensCurrent: 0,
      pricePointsInserted: 0,
      klinesInserted: 0,
    };

    const emitProgress = () => {
      if (onProgress) onProgress({ ...progress });
    };

    // Generate a unique sync ID (timestamp-based)
    const syncId = Date.now();

    try {
      // Check for existing completed sync
      if (!opts.force) {
        const existing = await this.getLastSync(opts.coin, opts.year, opts.month);
        if (existing) {
          this.running = false;
          return {
            syncId: Number(existing.id),
            status: "completed",
            eventsCount: 0,
            marketsCount: 0,
            pricePointsCount: 0,
            klinesCount: 0,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Insert sync_log entry
      await this.db.insert("scanner.sync_log", [
        {
          id: syncId,
          coin: opts.coin.toUpperCase(),
          year: opts.year,
          month: opts.month,
          period_type: "monthly",
          started_at: new Date().toISOString().slice(0, 19).replace("T", " "),
          status: "running",
        },
      ]);

      // ── Phase 1: Fetch events ───────────────────────────────────
      progress.phase = "events";
      progress.detail = `Fetching ${opts.coin} events for ${opts.year}-${opts.month}...`;
      emitProgress();

      const dateFilter: DateFilter = { year: opts.year, month: opts.month };
      const events = await fetchResolvedCryptoEvents(
        opts.coin,
        100,
        dateFilter,
      );

      progress.eventsTotal = events.length;
      progress.detail = `Found ${events.length} events`;
      emitProgress();

      // Insert events
      const eventRows = events.map((e) => ({
        event_id: e.id,
        title: e.title,
        slug: e.slug || "",
        coin: opts.coin.toUpperCase(),
        start_date: toClickHouseDateTime(e.startDate),
        end_date: toClickHouseDateTime(e.endDate),
        period: `${opts.year}-${String(opts.month).padStart(2, "0")}`,
        period_type: "monthly",
        active: e.active ? 1 : 0,
        closed: e.closed ? 1 : 0,
        volume: e.volume || 0,
        liquidity: e.liquidity || 0,
      }));

      if (eventRows.length > 0) {
        await this.db.insert("scanner.events", eventRows);
      }

      // ── Phase 2: Parse and insert markets ─────────────────────
      progress.phase = "markets";
      let totalMarkets = 0;
      const allTokenIds: { tokenId: string; eventStartDate: string; eventEndDate: string }[] = [];

      for (const event of events) {
        const marketRows = parseMarkets(event, opts.coin);
        totalMarkets += marketRows.length;

        for (const row of marketRows) {
          if (row.token_id) {
            allTokenIds.push({
              tokenId: row.token_id as string,
              eventStartDate: event.startDate,
              eventEndDate: event.endDate,
            });
          }
        }

        if (marketRows.length > 0) {
          await this.db.insert("scanner.markets", marketRows);
        }
      }

      progress.detail = `Inserted ${totalMarkets} markets`;
      progress.tokensTotal = allTokenIds.length;
      emitProgress();

      // ── Phase 3: Fetch and insert price histories ─────────────
      progress.phase = "price_history";
      let totalPoints = 0;

      for (let i = 0; i < allTokenIds.length; i++) {
        const { tokenId, eventStartDate, eventEndDate } = allTokenIds[i];
        progress.tokensCurrent = i + 1;
        progress.detail = `Token ${i + 1}/${allTokenIds.length}: ${tokenId.slice(-12)}...`;
        emitProgress();

        // Check if we already have data for this token
        const existingCount = await this.db.query<{ cnt: string }>(
          `SELECT count() as cnt FROM scanner.price_history WHERE token_id = '${esc(tokenId)}'`,
        );
        if (Number(existingCount[0]?.cnt || 0) > 0 && !opts.force) {
          continue; // skip, already have data
        }

        // Compute time range: month start to event end (or month end + buffer)
        const rangeStart = Math.floor(
          new Date(Date.UTC(opts.year, opts.month - 1, 1)).getTime() / 1000,
        );
        const eventEnd = eventEndDate
          ? Math.floor(new Date(eventEndDate).getTime() / 1000)
          : 0;
        const monthEnd = Math.floor(
          new Date(Date.UTC(opts.year, opts.month, 3)).getTime() / 1000,
        );
        const rangeEnd = Math.max(eventEnd, monthEnd);

        try {
          const points = await fetchPriceHistory(tokenId, rangeStart, rangeEnd);

          if (points.length > 0) {
            // Batch insert
            for (let j = 0; j < points.length; j += PRICE_HISTORY_BATCH) {
              const batch = points.slice(j, j + PRICE_HISTORY_BATCH);
              await this.db.insert(
                "scanner.price_history",
                batch.map((p) => ({
                  token_id: tokenId,
                  ts: p.t,
                  price: p.p,
                })),
              );
            }
            totalPoints += points.length;
            progress.pricePointsInserted = totalPoints;
            emitProgress();
          }
        } catch (err: any) {
          console.warn(`[sync] price history error for ${tokenId}: ${err.message}`);
        }

        // Rate limit to avoid hammering the API
        if (i < allTokenIds.length - 1) {
          await sleep(TOKEN_FETCH_DELAY_MS);
        }
      }

      // ── Phase 4: Fetch and insert Binance klines ──────────────
      progress.phase = "klines";
      progress.detail = "Fetching Binance klines...";
      emitProgress();

      let klinesCount = 0;
      const symbol = COIN_SYMBOLS[opts.coin.toUpperCase()];
      if (symbol) {
        const { startTime, endTime } = getMonthRange(opts.year, opts.month);

        try {
          // Fetch daily klines
          const dailyKlines = await fetchKlines(symbol, "1d", startTime, endTime);
          if (dailyKlines.length > 0) {
            await this.db.insert(
              "scanner.binance_klines",
              dailyKlines.map((k) => klineToRow(k, symbol, "1d")),
            );
            klinesCount += dailyKlines.length;
          }

          // Fetch hourly klines (may need multiple requests for a full month)
          const hourlyKlines = await fetchAllKlines(symbol, "1h", startTime, endTime);
          if (hourlyKlines.length > 0) {
            await this.db.insert(
              "scanner.binance_klines",
              hourlyKlines.map((k) => klineToRow(k, symbol, "1h")),
            );
            klinesCount += hourlyKlines.length;
          }

          progress.klinesInserted = klinesCount;
          progress.detail = `Inserted ${klinesCount} klines`;
          emitProgress();
        } catch (err: any) {
          console.warn(`[sync] klines error: ${err.message}`);
        }
      }

      // ── Done ──────────────────────────────────────────────────
      progress.phase = "done";
      progress.detail = "Sync completed";
      emitProgress();

      // Update sync_log
      await this.db.command(
        `ALTER TABLE scanner.sync_log UPDATE
          status = 'completed',
          events_count = ${events.length},
          markets_count = ${totalMarkets},
          price_points_count = ${totalPoints},
          klines_count = ${klinesCount},
          completed_at = now()
        WHERE id = ${syncId}`,
      );

      this.running = false;
      return {
        syncId,
        status: "completed",
        eventsCount: events.length,
        marketsCount: totalMarkets,
        pricePointsCount: totalPoints,
        klinesCount,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      // Update sync_log with error
      try {
        await this.db.command(
          `ALTER TABLE scanner.sync_log UPDATE
            status = 'failed',
            error = '${esc(err.message)}',
            completed_at = now()
          WHERE id = ${syncId}`,
        );
      } catch {
        // ignore update errors
      }

      this.running = false;
      return {
        syncId,
        status: "failed",
        eventsCount: 0,
        marketsCount: 0,
        pricePointsCount: 0,
        klinesCount: 0,
        durationMs: Date.now() - startTime,
        error: err.message,
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Escape values for safe use in ClickHouse string literals */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Convert ISO date string to ClickHouse DateTime format */
function toClickHouseDateTime(isoDate: string): string {
  if (!isoDate) return "1970-01-01 00:00:00";
  try {
    return new Date(isoDate).toISOString().slice(0, 19).replace("T", " ");
  } catch {
    return "1970-01-01 00:00:00";
  }
}

/** Parse markets from a GammaEvent into flat rows */
function parseMarkets(
  event: GammaEvent,
  coin: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  for (const market of event.markets) {
    try {
      const outcomes: string[] = JSON.parse(market.outcomes || "[]");
      const prices: number[] = JSON.parse(market.outcomePrices || "[]");
      const tokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");

      for (let i = 0; i < outcomes.length; i++) {
        rows.push({
          market_id: market.id,
          event_id: event.id,
          question: market.question || "",
          outcome: outcomes[i] || "",
          token_id: tokenIds[i] || "",
          final_price: prices[i] || 0,
          volume: parseFloat(market.volume || "0"),
          liquidity: parseFloat(market.liquidity || "0"),
        });
      }
    } catch {
      // skip unparseable markets
    }
  }

  return rows;
}

/** Convert a Kline to a row object for insertion */
function klineToRow(
  k: Kline,
  symbol: string,
  interval: string,
): Record<string, unknown> {
  return {
    symbol,
    interval,
    open_time: k.openTime,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    close_time: k.closeTime,
    quote_volume: k.quoteVolume,
    trades: k.trades,
  };
}

/** Fetch all klines for a time range, handling Binance's 1000-candle limit */
async function fetchAllKlines(
  symbol: CoinSymbol,
  interval: "1h" | "4h" | "1d" | "1w",
  startTime: number,
  endTime: number,
): Promise<Kline[]> {
  const all: Kline[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const batch = await fetchKlines(symbol, interval, cursor, endTime, 1000);
    if (batch.length === 0) break;
    all.push(...batch);
    // Move cursor past the last candle
    cursor = batch[batch.length - 1].closeTime + 1;
    if (batch.length < 1000) break; // no more data
  }

  return all;
}
