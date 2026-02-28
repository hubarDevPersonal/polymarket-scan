# Contributing

Thanks for your interest in contributing to Polymarket Scanner! This document covers the basics to get you started.

## Development Setup

```bash
# Clone and install
git clone https://github.com/your-username/polymarket-scanner.git
cd polymarket-scanner
npm install

# Copy environment config
cp .env.example .env

# Start in development mode (hot reload)
npm run dev
```

The dev server runs on `http://localhost:3847` with hot reloading via `tsx watch`.

### Optional: ClickHouse

For historical database features, run ClickHouse locally:

```bash
docker compose up clickhouse -d
```

Set `DB_ENABLED=true` in your `.env` file.

## Project Structure

```
src/
  index.ts          # Entry point, orchestration, graceful shutdown
  server.ts         # Express server, API routes, security middleware
  gamma.ts          # Polymarket Gamma API client
  binance.ts        # Binance klines API
  history.ts        # Historical data fetching
  ws-client.ts      # WebSocket client for Polymarket CLOB
  orderbook.ts      # Orderbook analytics engine
  detector.ts       # Opportunity detection
  telegram.ts       # Telegram alerts
  notion-sync.ts    # Notion integration
  audit.ts          # DynamoDB audit logging
  db/
    connection.ts   # ClickHouse connection management
    schema.ts       # Table definitions
    sync.ts         # Historical sync engine
    queries.ts      # Predefined analytics queries
public/
  index.html        # Single-page frontend (HTML + CSS + JS)
```

## Code Style

- TypeScript strict mode is enabled
- Run `npm run lint` to check for issues
- Run `npm run format` to auto-format with Prettier
- Run `npm run typecheck` to verify TypeScript types

## Making Changes

1. Create a feature branch: `git checkout -b feature/my-change`
2. Make your changes
3. Verify TypeScript compiles: `npm run typecheck`
4. Run linting: `npm run lint`
5. Test locally: `npm run dev`
6. Commit and open a pull request

## Guidelines

- Keep the frontend as a single `index.html` file (no build step for the UI)
- All SQL queries must use proper escaping — never interpolate user input directly
- New API endpoints should include input validation
- Heavy endpoints should use the `heavyLimiter` rate limiter
- Maintain backward compatibility with existing API responses

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (Node version, OS, browser)
