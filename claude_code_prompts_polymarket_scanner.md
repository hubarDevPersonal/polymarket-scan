# Claude Code Prompt Pack — Polymarket Orderbook Scanner (Updated 2026-02-25)

Use these prompts as-is in Claude Code to implement the scanner and analytics.

---

## Prompt 1 — Build a production WS+REST book ingestor (TypeScript)

You are implementing a Polymarket CLOB orderbook scanner.

Specs (use Polymarket docs as source of truth):
- WS endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
  - Docs: https://docs.polymarket.com/api-reference/wss/market
- REST snapshot:
  - Single: `GET https://clob.polymarket.com/book`
    - Docs: https://docs.polymarket.com/api-reference/market-data/get-order-book
  - Batch: `POST https://clob.polymarket.com/books`
    - Docs: https://docs.polymarket.com/api-reference/market-data/get-order-books-request-body
- Rate limits: Cloudflare throttling; avoid polling
  - Docs: https://docs.polymarket.com/api-reference/rate-limits

Requirements:
1) Accept a list of token IDs (assets_ids) to scan.
2) Bootstrap with REST snapshots (batch when possible).
3) Connect to WS market channel and subscribe.
4) Maintain an in-memory L2 orderbook per token with a pure reducer:
   - `applySnapshot(tokenId, snapshot)`
   - `applyDelta(tokenId, delta)`
5) Reconnect with exponential backoff:
   - On reconnect: REST resync then re-subscribe.
6) Expose `onTopOfBook(tokenId, bestBid, bestAsk, mid, spread)` callback when top changes.

Implementation constraints:
- Avoid float drift; use decimal-safe arithmetic.
- Min dependencies (e.g., `ws` only).
- Add unit tests: replay recorded events; assert final best bid/ask + depth.

Deliverables:
- `wsClient.ts`, `restClient.ts`, `orderbook.ts` (reducer), `index.ts`
- Tests in `__tests__/orderbook.test.ts`

---

## Prompt 2 — Add analytics: depth/imbalance/slippage grids

Extend the project with:
- depth at 10/25/50 bps (both sides)
- imbalance within 25 bps
- slippage estimator via book-walk for a grid of quantities
- optional: compute midpoint; note Polymarket UI behavior where very wide spreads may display last trade (see trading/orderbook docs)

Docs references:
- Orderbook guide: https://docs.polymarket.com/trading/orderbook
- Midpoint endpoint (optional): https://docs.polymarket.com/api-reference/data/get-midpoint-price

Deliverables:
- `analytics.ts` (pure functions) + tests
- CLI example that prints metrics every second

---

## Prompt 3 — (Optional) Add user-channel fills tracking

If placing orders, add the authenticated User WS channel:
- Endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/user`
  - Docs: https://docs.polymarket.com/api-reference/wss/user
  - Guide: https://docs.polymarket.com/market-data/websocket/user-channel

Deliverables:
- `userWsClient.ts` that consumes trade/order updates
- A small “execution report” module that measures fill rate + post-fill adverse selection

---

## Prompt 4 — (Optional) Execution helper: passive spread capture

Design a passive strategy module:
- Enter when spread > threshold and depth is sufficient.
- Place bids/asks at configurable offsets.
- Cancel/replace when top-of-book moves.
- Risk controls: timeout, cancel-all on shutdown, max exposure.

Deliverables:
- Architecture diagram (markdown) + code skeleton
- Clear notes about queue priority and adverse selection
