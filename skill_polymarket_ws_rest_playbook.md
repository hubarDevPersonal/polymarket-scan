# Polymarket WS + REST Playbook for a Book Scanner (Updated 2026-02-25)

Goal: maintain a correct local **L2 orderbook** for many tokens with minimal latency and safe resync.

---

## A) Endpoints you’ll use

### Market discovery (Gamma API, public)
- Quickstart: https://docs.polymarket.com/quickstart
- Markets & Events concept: https://docs.polymarket.com/concepts/markets-events
- Fetching markets strategies: https://docs.polymarket.com/market-data/fetching-markets

### CLOB market data (public)
- Single book: `GET https://clob.polymarket.com/book`
  - Docs: https://docs.polymarket.com/api-reference/market-data/get-order-book
- Batch books: `POST https://clob.polymarket.com/books`
  - Docs: https://docs.polymarket.com/api-reference/market-data/get-order-books-request-body

### WebSocket market channel (public)
- `wss://ws-subscriptions-clob.polymarket.com/ws/market`
  - Docs: https://docs.polymarket.com/api-reference/wss/market
  - Guide: https://docs.polymarket.com/market-data/websocket/market-channel

### Rate limits (Cloudflare throttling)
- https://docs.polymarket.com/api-reference/rate-limits

---

## B) Minimal robust flow (recommended)

1) Resolve token IDs to scan
- From Gamma, extract outcome token IDs for markets you care about.
- Partition into batches for REST `/books` and WS subscriptions.

2) Bootstrap snapshots (REST)
- Prefer `POST /books` to bootstrap many tokens efficiently.
- Build local books from snapshots.

3) Start WebSocket
- Connect to: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Subscribe:
```json
{
  "assets_ids": ["<TOKEN_ID_1>", "<TOKEN_ID_2>"],
  "type": "market"
}
```

Optional: enable extra events (see trading/orderbook guide):
- https://docs.polymarket.com/trading/orderbook

4) Apply messages
- Snapshot message: replace local book
- Delta message: update levels (set size; remove on zero)
- Trade message: update rolling stats (optional)

5) Health + reconnect + resync
- If socket closes or stalls:
  - reconnect with exponential backoff
  - REST snapshot resync for affected tokens
  - re-subscribe

---

## C) Data structures & numeric safety

### Decimal handling
- Treat all prices/sizes as **strings in transit** and convert using a decimal library (TS) or big.Rat/decimal (Go).
- Avoid floats.

### Book model
- `bids: Map[price] -> size`
- `asks: Map[price] -> size`
- Maintain:
  - best bid/ask
  - cumulative depth ladders
  - cached sorted levels (rebuild incrementally)

Correctness invariants:
- sizes >= 0
- remove a level when size == 0
- best_bid <= best_ask (normally strict; crossed states require resync)

---

## D) Test strategy
- Record WS frames + periodic snapshots.
- Replay deterministically through the reducer.
- Inject disconnects and verify resync returns you to a consistent state.
