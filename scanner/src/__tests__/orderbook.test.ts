import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  createBook,
  applySnapshot,
  applyDelta,
  getBestBid,
  getBestAsk,
  getMid,
  getSpread,
  getSortedBids,
  getSortedAsks,
  BookSnapshot,
} from "../orderbook";

function makeSnap(
  bids: Array<[string, string]>,
  asks: Array<[string, string]>,
): BookSnapshot {
  return {
    market: "m1",
    asset_id: "token1",
    timestamp: new Date().toISOString(),
    hash: "abc",
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
  };
}

describe("createBook", () => {
  it("initializes with empty bids/asks", () => {
    const book = createBook("token1");
    expect(book.tokenId).toBe("token1");
    expect(book.bids.size).toBe(0);
    expect(book.asks.size).toBe(0);
    expect(book.lastTradePrice).toBeNull();
    expect(book.deltaCount).toBe(0);
  });
});

describe("applySnapshot", () => {
  it("populates bids and asks from snapshot", () => {
    const book = createBook("token1");
    applySnapshot(book, makeSnap(
      [["0.50", "100"], ["0.49", "200"]],
      [["0.52", "150"], ["0.53", "50"]],
    ));
    expect(book.bids.size).toBe(2);
    expect(book.asks.size).toBe(2);
  });

  it("ignores zero-size levels", () => {
    const book = createBook("token1");
    applySnapshot(book, makeSnap(
      [["0.50", "100"], ["0.49", "0"]],
      [["0.52", "0"]],
    ));
    expect(book.bids.size).toBe(1);
    expect(book.asks.size).toBe(0);
  });

  it("clears previous state on re-snapshot", () => {
    const book = createBook("token1");
    applySnapshot(book, makeSnap([["0.50", "100"]], [["0.52", "50"]]));
    applySnapshot(book, makeSnap([["0.60", "200"]], []));
    expect(book.bids.size).toBe(1);
    expect(book.bids.has("0.60")).toBe(true);
    expect(book.bids.has("0.50")).toBe(false);
    expect(book.asks.size).toBe(0);
  });
});

describe("applyDelta", () => {
  it("adds a new bid level", () => {
    const book = createBook("token1");
    applyDelta(book, { asset_id: "token1", price: "0.55", size: "100", side: "BUY" });
    expect(book.bids.size).toBe(1);
    expect(book.bids.get("0.55")?.toNumber()).toBe(100);
    expect(book.deltaCount).toBe(1);
  });

  it("removes a level when size is zero", () => {
    const book = createBook("token1");
    applyDelta(book, { asset_id: "token1", price: "0.55", size: "100", side: "BUY" });
    applyDelta(book, { asset_id: "token1", price: "0.55", size: "0", side: "BUY" });
    expect(book.bids.size).toBe(0);
    expect(book.deltaCount).toBe(2);
  });

  it("handles lowercase side", () => {
    const book = createBook("token1");
    applyDelta(book, { asset_id: "token1", price: "0.60", size: "50", side: "sell" });
    expect(book.asks.size).toBe(1);
  });
});

describe("best bid/ask/mid/spread", () => {
  it("returns null on empty book", () => {
    const book = createBook("token1");
    expect(getBestBid(book)).toBeNull();
    expect(getBestAsk(book)).toBeNull();
    expect(getMid(book)).toBeNull();
    expect(getSpread(book)).toBeNull();
  });

  it("computes best bid and ask correctly", () => {
    const book = createBook("token1");
    applySnapshot(book, makeSnap(
      [["0.50", "100"], ["0.48", "200"], ["0.52", "50"]],
      [["0.55", "100"], ["0.57", "200"], ["0.54", "50"]],
    ));
    expect(getBestBid(book)!.toNumber()).toBe(0.52);
    expect(getBestAsk(book)!.toNumber()).toBe(0.54);
  });

  it("computes mid price", () => {
    const book = createBook("token1");
    applySnapshot(book, makeSnap(
      [["0.50", "100"]],
      [["0.54", "100"]],
    ));
    expect(getMid(book)!.toNumber()).toBe(0.52);
  });

  it("computes spread", () => {
    const book = createBook("token1");
    applySnapshot(book, makeSnap(
      [["0.50", "100"]],
      [["0.54", "100"]],
    ));
    expect(getSpread(book)!.toNumber()).toBe(0.04);
  });
});

describe("getSortedBids / getSortedAsks", () => {
  it("sorts bids descending by price", () => {
    const book = createBook("token1");
    applySnapshot(book, makeSnap(
      [["0.48", "100"], ["0.52", "100"], ["0.50", "100"]],
      [],
    ));
    const bids = getSortedBids(book);
    expect(bids.map((l) => l.price.toNumber())).toEqual([0.52, 0.50, 0.48]);
  });

  it("sorts asks ascending by price", () => {
    const book = createBook("token1");
    applySnapshot(book, makeSnap(
      [],
      [["0.57", "100"], ["0.54", "100"], ["0.55", "100"]],
    ));
    const asks = getSortedAsks(book);
    expect(asks.map((l) => l.price.toNumber())).toEqual([0.54, 0.55, 0.57]);
  });
});
