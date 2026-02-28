# Slippage & Passive Limit Execution in CLOB Markets (Updated 2026-02-25)

This doc is **conceptual + implementation-ready** guidance for slippage estimation and limit-order execution logic
in an orderbook (CLOB) context such as Polymarket.

---

## 1) Slippage in a classic orderbook (what it really is)

There is usually no special “slippage mechanism” in a matching engine.
Slippage is an *emergent* result of:

1) **Crossing the spread**
- Market buys hit the **best ask**
- Market sells hit the **best bid**
Immediate cost = spread component.

2) **Walking the book**
If your order size > liquidity at the best price level, you consume multiple levels:
- Buy: consume asks upward
- Sell: consume bids downward
Average fill price moves against you with depth.

3) **Latency + adverse selection**
Between decision and execution, the book can change.
Passive orders can be filled when the market is moving (information arrival).

Polymarket note:
- “All orders are limit orders”; “market orders” are implemented by sending a **marketable limit order** that executes immediately at the best available book prices:
  - https://docs.polymarket.com/trading/orders/overview

---

## 2) Why passive limit orders *reduce* slippage (and what you pay)

A limit order guarantees **price or better**, but not execution.

Benefits:
- Can capture spread (maker-like behavior) if you rest inside spread or at touch
- Avoids uncontrolled book-walking beyond your limit price

Costs:
- **Fill uncertainty** (no fill / partial fill)
- **Queue risk** (price-time priority: earlier orders at same price fill first)
- **Adverse selection** (you get filled when price is about to move against you)

---

## 3) Baseline slippage estimator (walk-the-book simulation)

Given a side of the L2 book as levels (price, size), sorted:
- Buy uses asks ascending
- Sell uses bids descending

Algorithm:
1) For each level, take `take = min(remaining_qty, level_size)`
2) Accumulate `cost += take * price`
3) Stop when filled or book ends

Outputs:
- `avg_fill = cost / filled`
- Compare to:
  - `mid = (best_bid + best_ask)/2`
  - `touch = best_ask` for buy, `best_bid` for sell
- Slippage:
  - `slip_mid = (avg_fill - mid)/mid`
  - `slip_touch = (avg_fill - touch)/touch`

Enhancements (optional):
- Latency model (probability of book change during execution window)
- Refill/cancel rates by level
- Alpha/avoidance filters (don’t post when volatility spikes)

---

## 4) Practical passive execution pattern (scanner-friendly)

If your idea is “control slippage by posting bids/asks around large spreads”:
- Detect wide spread markets.
- Post passive orders:
  - at best bid/ask (join) or inside spread (improve)
- Cancel/replace as the book moves (to avoid being stranded off-market).
- Measure performance:
  - fill rate
  - average price improvement vs touch/mid
  - adverse selection (post-fill mid-price movement)

User-level fills tracking (if you trade):
- Use the authenticated **User WebSocket** channel:
  - https://docs.polymarket.com/api-reference/wss/user
  - Guide: https://docs.polymarket.com/market-data/websocket/user-channel
