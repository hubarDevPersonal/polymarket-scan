# Polymarket Scanner

[![CI](https://github.com/anthropics/polymarket-scanner/actions/workflows/ci.yml/badge.svg)](https://github.com/anthropics/polymarket-scanner/actions/workflows/ci.yml)

Real-time orderbook scanner for crypto prediction markets on [Polymarket](https://polymarket.com). Tracks bid/ask spreads, detects arbitrage opportunities, and compares prediction odds against Binance spot prices with full historical analytics powered by ClickHouse.

<!-- ![Screenshot](docs/screenshot.png) -->

## Features

- **Orderbook Scanning** — Live WebSocket connection to Polymarket CLOB, tracking best bid/ask, spread, and depth for every outcome token
- **Spread Detection** — Configurable alerts when spreads exceed thresholds or arbitrage opportunities appear across related markets
- **Binance Comparison** — Side-by-side view of Polymarket prediction odds vs actual Binance price action (BTC, ETH, SOL)
- **Historical Database** — ClickHouse-backed storage of resolved events, price histories, and Binance klines for backtesting
- **SQL Explorer** — Ad-hoc read-only SQL queries against the historical database directly from the UI
- **Telegram Alerts** — Real-time notifications for detected opportunities with configurable severity and rate limiting
- **Notion Sync** — Automated daily/weekly reports synced to Notion databases
- **DynamoDB Audit Log** — Optional audit trail of all critical system events

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/your-username/polymarket-scanner.git
cd polymarket-scanner
cp .env.example .env
# Edit .env with your configuration
docker compose up -d
```

The scanner will be available at `http://localhost:3847`.

### Local Development

```bash
# Prerequisites: Node.js 20+, ClickHouse (optional)
npm install
cp .env.example .env
npm run dev
```

## Development

```bash
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type-check without emitting
npm run lint         # Run ESLint
npm run format       # Auto-format with Prettier
npm test             # Run all tests
npm run test:watch   # Run tests in watch mode
```

### Project Structure

```
src/
  index.ts           # Entry point, orchestration, graceful shutdown
  server.ts          # Express server, API routes, security middleware
  binance.ts         # Binance klines API client
  gamma.ts           # Polymarket Gamma API client
  history.ts         # Historical data fetching
  ws-client.ts       # WebSocket client for Polymarket CLOB
  orderbook.ts       # Orderbook analytics engine
  detector.ts        # Spread/arbitrage opportunity detection
  telegram.ts        # Telegram notification alerts
  notion-sync.ts     # Notion integration
  audit.ts           # DynamoDB audit logging
  db/
    connection.ts    # ClickHouse connection management
    schema.ts        # Table definitions
    sync.ts          # Historical sync engine
    queries.ts       # Predefined analytics queries
  __tests__/
    binance.test.ts  # Time range helpers
    orderbook.test.ts# Book state, snapshots, deltas
    queries.test.ts  # SQL validation & safety
    server.test.ts   # HTTP API endpoints
public/
  index.html         # Single-page frontend (HTML + CSS + JS)
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3847` | HTTP server port |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |
| `DB_ENABLED` | `true` | Enable ClickHouse historical database |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_DB` | `scanner` | ClickHouse database name |
| `TELEGRAM_ENABLED` | `false` | Enable Telegram alerts |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Telegram chat/group ID |
| `TELEGRAM_MIN_SEVERITY` | `alert` | Minimum severity to send (`info`, `alert`, `critical`) |
| `NOTION_SYNC_ENABLED` | `false` | Enable Notion sync |
| `NOTION_TOKEN` | — | Notion internal integration token |
| `NOTION_DAILY_DB` | — | Notion database ID for daily reports |
| `NOTION_WEEKLY_DB` | — | Notion database ID for weekly reports |
| `AUDIT_ENABLED` | `false` | Enable DynamoDB audit logging |
| `ALEXBOT_ALERTS_ENABLED` | `false` | Enable AlexBot webhook alerts |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Browser UI                      │
│  (Orderbook · Compare · Database · SQL · Alerts) │
└────────────────┬────────────────────────────────┘
                 │ SSE + REST
┌────────────────┴────────────────────────────────┐
│              Express Server (:3847)              │
│  helmet · cors · rate-limit · input validation   │
├──────────┬──────────┬──────────┬────────────────┤
│ Polymarket│ Binance  │ClickHouse│   Integrations │
│ WebSocket │  REST    │   DB     │ Telegram/Notion│
│   CLOB    │ Klines   │ History  │ DynamoDB/Alerts│
└──────────┴──────────┴──────────┴────────────────┘
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check with uptime and memory stats |
| `GET` | `/api/events` | List discovered prediction events |
| `GET` | `/api/event/:id/books` | Orderbooks for an event |
| `GET` | `/api/book/:tokenId` | Analytics for a single token |
| `GET` | `/api/book/:tokenId/ladder` | Full orderbook ladder |
| `GET` | `/api/opportunities` | Active spread/arbitrage opportunities |
| `GET` | `/api/stream` | SSE stream for real-time updates |
| `GET` | `/api/compare/binance/:coin` | Binance klines for a coin |
| `GET` | `/api/compare/events/:coin` | Resolved Polymarket events |
| `GET` | `/api/compare/price-history/:tokenId` | Token price history |
| `POST` | `/api/db/sync` | Trigger historical data sync (SSE) |
| `GET` | `/api/db/stats` | ClickHouse table statistics |
| `POST` | `/api/db/query` | Execute read-only SQL query |

## CI/CD

This project uses GitHub Actions for continuous integration and deployment.

**CI Pipeline** (runs on every push/PR to `main`):
1. **Lint** — ESLint checks across all source files
2. **Type Check** — TypeScript strict mode validation
3. **Test** — Vitest unit test suite (49 tests)
4. **Build** — TypeScript compilation + artifact upload
5. **Docker** — Docker image build verification with BuildKit cache

**Deploy Pipeline** (runs on push to `main`):
- SSH into VPS, pulls latest code, rebuilds Docker image, restarts containers
- Runs a 60-second health check loop against `/api/health`
- Requires GitHub Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`

## Deployment

### VPS Setup

```bash
# On your VPS
git clone https://github.com/your-username/polymarket-scanner.git
cd polymarket-scanner
cp .env.example .env
# Edit .env with production values
docker compose up -d
```

### GitHub Secrets

Set these in your repo settings for automated deployments:

| Secret | Description |
|---|---|
| `VPS_HOST` | Server IP or hostname |
| `VPS_USER` | SSH username |
| `VPS_SSH_KEY` | Private SSH key (ed25519 recommended) |
| `VPS_APP_DIR` | App directory on server (default: `~/polymarket-scanner`) |

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript (strict mode)
- **Server**: Express with helmet, CORS, rate limiting
- **Data**: ClickHouse (historical), DynamoDB (audit)
- **Frontend**: Vanilla HTML/CSS/JS with Chart.js
- **APIs**: Polymarket CLOB (WebSocket), Binance (REST), Gamma Markets
- **Integrations**: Telegram Bot API, Notion API
- **Testing**: Vitest
- **CI/CD**: GitHub Actions + Docker

## License

[MIT](LICENSE)
