// ClickHouse DDL for historical Polymarket + Binance data
// All tables use ReplacingMergeTree for safe re-syncs (dedup on merge)

export const SCHEMA_DDL = [
  `CREATE DATABASE IF NOT EXISTS scanner`,

  // Polymarket events
  `CREATE TABLE IF NOT EXISTS scanner.events (
    event_id   String,
    title      String,
    slug       String,
    coin       LowCardinality(String),
    start_date DateTime,
    end_date   DateTime,
    period     String,
    period_type LowCardinality(String),
    active     UInt8,
    closed     UInt8,
    volume     Float64,
    liquidity  Float64,
    synced_at  DateTime DEFAULT now()
  ) ENGINE = ReplacingMergeTree(synced_at)
  ORDER BY (coin, event_id)`,

  // Markets / outcomes within events
  `CREATE TABLE IF NOT EXISTS scanner.markets (
    market_id   String,
    event_id    String,
    question    String,
    outcome     String,
    token_id    String,
    final_price Float64,
    volume      Float64,
    liquidity   Float64,
    synced_at   DateTime DEFAULT now()
  ) ENGINE = ReplacingMergeTree(synced_at)
  ORDER BY (event_id, market_id, outcome)`,

  // Outcome token price history (the big table)
  `CREATE TABLE IF NOT EXISTS scanner.price_history (
    token_id String,
    ts       UInt64,
    price    Float64
  ) ENGINE = ReplacingMergeTree()
  ORDER BY (token_id, ts)`,

  // Binance candlestick data
  `CREATE TABLE IF NOT EXISTS scanner.binance_klines (
    symbol       LowCardinality(String),
    interval     LowCardinality(String),
    open_time    UInt64,
    open         Float64,
    high         Float64,
    low          Float64,
    close        Float64,
    volume       Float64,
    close_time   UInt64,
    quote_volume Float64,
    trades       UInt32
  ) ENGINE = ReplacingMergeTree()
  ORDER BY (symbol, interval, open_time)`,

  // Sync log for incremental sync tracking
  `CREATE TABLE IF NOT EXISTS scanner.sync_log (
    id                  UInt64,
    coin                String,
    year                UInt16,
    month               UInt8,
    period_type         String,
    events_count        UInt32 DEFAULT 0,
    markets_count       UInt32 DEFAULT 0,
    price_points_count  UInt64 DEFAULT 0,
    klines_count        UInt32 DEFAULT 0,
    started_at          DateTime,
    completed_at        Nullable(DateTime),
    status              LowCardinality(String) DEFAULT 'running',
    error               Nullable(String)
  ) ENGINE = MergeTree()
  ORDER BY (coin, year, month, started_at)`,
];
