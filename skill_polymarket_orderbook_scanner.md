# Polymarket CLOB Orderbook Scanner — Context Pack (Updated 2026-02-25)

This document is a **developer context pack** for building a **Polymarket orderbook scanner + analyzer**.
It focuses on **market-data (public) ingestion** first; trading/execution is optional.

---

## 1) What you’re building

A service that:
1. Discovers Polymarket markets and their **outcome token IDs** (via **Gamma API**).
2. Bootstraps **L2 orderbook snapshots** via **CLOB REST**.
3. Streams **near real-time orderbook updates** via the **CLOB WebSocket market channel**.
4. Maintains an in-memory **L2 book** per token, and computes metrics (spread, mid, depth, imbalance).
5. Estimates **slippage** by simulating “walk-the-book” fills for hypothetical order sizes.

Polymarket’s CLOB uses **EIP-712 signed orders** authorizing the onchain Exchange contract to execute trades without custodying funds; see:
- Order lifecycle: https://docs.polymarket.com/concepts/order-lifecycle
- Orders overview (all orders are limit; “market” achieved via marketable limit): https://docs.polymarket.com/trading/orders/overview

---

## 2) Core identifiers you must understand

### 2.1 Slug → Market/Event → Outcome tokens
- Polymarket URLs include an **event slug**; you can fetch event/market metadata from **Gamma API**:
  - Markets/events concept: https://docs.polymarket.com/concepts/markets-events
  - Quickstart market fetching: https://docs.polymarket.com/quickstart
  - Fetching markets strategies: https://docs.polymarket.com/market-data/fetching-markets

What you ultimately need for a book scanner is the **tradable token ID** (one per outcome).

### 2.2 Token ID / Asset ID (orderbook key)
Orderbook endpoints and WS subscriptions use the **token ID** (often called `token_id`, and WS uses `assets_ids`).

---

## 3) Data access: REST snapshots + WebSocket deltas

### 3.1 REST: single-book snapshot
Official endpoint:
- `GET https://clob.polymarket.com/book` (provide token ID parameter; see API reference)
Docs:
- https://docs.polymarket.com/api-reference/market-data/get-order-book

Use cases:
- Cold start bootstrap
- Re-sync after WS disconnect
- Periodic integrity check (optional)

### 3.2 REST: batch books
For scanning many markets, prefer the batch endpoint:
- `POST https://clob.polymarket.com/books`
Docs:
- https://docs.polymarket.com/api-reference/market-data/get-order-books-request-body

### 3.3 WebSocket: market channel (primary for speed)
Official endpoint:
- `wss://ws-subscriptions-clob.polymarket.com/ws/market`
Docs (API reference):
- https://docs.polymarket.com/api-reference/wss/market
Docs (guide):
- https://docs.polymarket.com/market-data/websocket/market-channel

Basic subscription:
```json
{
  "assets_ids": ["<TOKEN_ID_1>", "<TOKEN_ID_2>"],
  "type": "market"
}
```

The trading “Orderbook” guide shows an optional `custom_feature_enabled` flag enabling extra events (e.g., `best_bid_ask`, `new_market`, `market_resolved`):
- https://docs.polymarket.com/trading/orderbook

---

## 4) Rate limits: design for throttling (not polling)
Polymarket rate limits are enforced via **Cloudflare throttling**; when you exceed a limit, requests are **delayed/queued** rather than immediately rejected.
Docs:
- https://docs.polymarket.com/api-reference/rate-limits

Practical guidance:
- Use **WS** for high-frequency updates.
- Use REST for bootstrap/resync and low-rate background checks.

---

## 5) Recommended architecture (scanner + analyzer)

### 5.1 Components
1) **Discovery module (Gamma API)**
- Find markets and their outcome token IDs.
- Filter for tradable/orderbook-enabled markets (fields vary; rely on Gamma market metadata).

2) **Snapshot loader (CLOB REST)**
- For a set of tokens: fetch `/books` (batch) where possible.
- Normalize numeric strings; store prices/sizes as decimals (avoid float drift).

3) **WS ingestor (market channel)**
- Subscribe to tokens.
- Apply snapshot/delta messages to in-memory books.
- Reconnect with backoff; on reconnect, re-bootstrap snapshots first.

4) **Orderbook state**
- `bids: Map[price] -> size`
- `asks: Map[price] -> size`
- Maintain sorted structure (tree / skiplist / sorted arrays) for:
  - best bid/ask
  - depth ladders
  - slippage simulation

5) **Analytics**
- Top-of-book: best bid/ask, spread, mid, last trade
- Depth at bps: 10/25/50 bps
- Imbalance: (bid depth − ask depth) / total depth
- Slippage estimator: book-walk average fill price for multiple quantities

### 5.2 Correctness + resilience
- After reconnect, do a **REST snapshot resync** before processing fresh deltas.
- Detect stalled sockets (no messages) and restart.
- If the feed includes sequence numbers, implement gap detection; otherwise rely on resync.

---

## 6) Helpful official code & agent references
- Official SDK mention (TS/Python) & trading overview:
  - https://docs.polymarket.com/trading/overview
- Polymarket “agent skills” repo (reference patterns, endpoints, workflows):
  - https://github.com/Polymarket/agent-skills
- Polymarket CLI (practical reference):
  - https://github.com/Polymarket/polymarket-cli
