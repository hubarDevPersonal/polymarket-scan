import { ClickHouseDb } from "./connection";

// ─── Helpers ────────────────────────────────────────────────────────

/** Escape a value for safe use in ClickHouse string literals */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ─── Pre-built analytical queries ────────────────────────────────

/** Daily comparison: Binance close price vs avg Polymarket probabilities */
export async function dailyComparison(
  db: ClickHouseDb,
  coin: string,
  year: number,
  month: number,
): Promise<unknown[]> {
  const symbol = esc(`${coin.toUpperCase()}USDT`);
  const coinUpper = esc(coin.toUpperCase());
  const period = esc(`${year}-${String(month).padStart(2, "0")}`);

  return db.query(`
    WITH daily_prices AS (
      SELECT
        toDate(toDateTime(open_time / 1000)) AS day,
        argMax(close, open_time) AS coin_close,
        max(high) AS coin_high,
        min(low) AS coin_low
      FROM scanner.binance_klines
      WHERE symbol = '${symbol}' AND interval = '1d'
      GROUP BY day
    ),
    daily_probs AS (
      SELECT
        toDate(toDateTime(ph.ts)) AS day,
        m.question,
        m.outcome,
        e.title AS event_title,
        avg(ph.price) AS avg_prob,
        max(ph.price) AS max_prob,
        min(ph.price) AS min_prob,
        count() AS points
      FROM scanner.price_history ph
      JOIN scanner.markets m ON m.token_id = ph.token_id
      JOIN scanner.events e ON e.event_id = m.event_id
      WHERE e.coin = '${coinUpper}' AND e.period = '${period}'
        AND m.outcome = 'Yes'
      GROUP BY day, m.question, m.outcome, e.title
    )
    SELECT
      dp.day,
      dp.coin_close,
      dp.coin_high,
      dp.coin_low,
      dp2.question,
      dp2.event_title,
      dp2.avg_prob,
      dp2.max_prob,
      dp2.min_prob,
      dp2.points
    FROM daily_prices dp
    LEFT JOIN daily_probs dp2 ON dp.day = dp2.day
    ORDER BY dp.day, dp2.question
  `);
}

/** Event summary: all events with their outcome counts and price point counts */
export async function eventSummary(
  db: ClickHouseDb,
  coin: string,
  year: number,
  month: number,
): Promise<unknown[]> {
  const coinUpper = esc(coin.toUpperCase());
  const period = esc(`${year}-${String(month).padStart(2, "0")}`);

  return db.query(`
    SELECT
      e.event_id,
      e.title,
      e.start_date,
      e.end_date,
      e.closed,
      e.volume,
      count(DISTINCT m.market_id) AS markets_count,
      count(DISTINCT m.token_id) AS tokens_count,
      sum(ph_cnt.cnt) AS total_price_points
    FROM scanner.events e
    LEFT JOIN scanner.markets m ON m.event_id = e.event_id
    LEFT JOIN (
      SELECT token_id, count() AS cnt
      FROM scanner.price_history
      GROUP BY token_id
    ) ph_cnt ON ph_cnt.token_id = m.token_id
    WHERE e.coin = '${coinUpper}' AND e.period = '${period}'
    GROUP BY e.event_id, e.title, e.start_date, e.end_date, e.closed, e.volume
    ORDER BY e.volume DESC
  `);
}

/** Table stats: row counts for all tables */
export async function tableStats(db: ClickHouseDb): Promise<unknown[]> {
  return db.query(`
    SELECT
      'events' AS table_name, count() AS rows FROM scanner.events
    UNION ALL
    SELECT 'markets', count() FROM scanner.markets
    UNION ALL
    SELECT 'price_history', count() FROM scanner.price_history
    UNION ALL
    SELECT 'binance_klines', count() FROM scanner.binance_klines
    UNION ALL
    SELECT 'sync_log', count() FROM scanner.sync_log
  `);
}

/** Execute an arbitrary SELECT query (read-only) */
export async function executeQuery(
  db: ClickHouseDb,
  sql: string,
): Promise<{ columns: string[]; rows: unknown[] }> {
  // Only allow SELECT / WITH / SHOW / DESCRIBE
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH|SHOW|DESCRIBE|DESC)\b/i.test(trimmed)) {
    throw new Error("Only SELECT, WITH, SHOW, and DESCRIBE queries are allowed");
  }

  // Block dangerous patterns
  const blocked = /\b(DROP|ALTER|DELETE|INSERT|CREATE|TRUNCATE|GRANT|ATTACH|DETACH)\b/i;
  if (blocked.test(trimmed)) {
    throw new Error("Query contains blocked keywords");
  }

  const rows = await db.query(sql);
  const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
  return { columns, rows };
}
