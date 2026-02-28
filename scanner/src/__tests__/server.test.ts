import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "events";
import type { Server } from "http";

// We import the createServer function and spin up a real Express server
// against mock state to test the HTTP API surface.
import { createServer } from "../server";

let server: Server;
let baseUrl: string;
const PORT = 0; // OS-assigned ephemeral port

const mockState = {
  events: [
    {
      id: "evt-1",
      title: "Will BTC reach $100k?",
      slug: "btc-100k",
      markets: [
        {
          id: "mkt-1",
          question: "BTC >= $100,000?",
          clobTokenIds: '["tok-yes","tok-no"]',
          outcomes: '["Yes","No"]',
          volumeNum: 50000,
          liquidityNum: 12000,
        },
      ],
    },
  ],
  bookAnalytics: new Map([
    ["tok-yes", { bestBid: 0.62, bestAsk: 0.64, spread: 0.02 }],
  ]),
  ladders: new Map([
    ["tok-yes", { bids: [], asks: [] }],
  ]),
  wsConnected: true,
  opportunities: [],
  getNotifications: (limit: number) => [],
  markAllRead: () => {},
  detectorConfig: {},
  updateDetectorConfig: () => {},
  wsStats: { messagesReceived: 100 },
  clickhouseDb: null,
  historySync: null,
};

const emitter = new EventEmitter();

beforeAll(async () => {
  const result = createServer(PORT, () => mockState, emitter);
  server = result.server;
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /api/health", () => {
  it("returns status ok with expected fields", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data).toHaveProperty("uptime");
    expect(data).toHaveProperty("memory");
    expect(data).toHaveProperty("wsConnected");
    expect(data).toHaveProperty("eventsLoaded");
    expect(data).toHaveProperty("booksTracked");
    expect(data).toHaveProperty("clickhouse");
  });
});

describe("GET /api/events", () => {
  it("returns events array", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("evt-1");
  });
});

describe("GET /api/event/:eventId/books", () => {
  it("returns books for a valid event", async () => {
    const res = await fetch(`${baseUrl}/api/event/evt-1/books`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.id).toBe("evt-1");
    expect(data.books).toHaveLength(2);
    expect(data.books[0].outcome).toBe("Yes");
    expect(data.books[1].outcome).toBe("No");
  });

  it("returns 404 for unknown event", async () => {
    const res = await fetch(`${baseUrl}/api/event/nonexistent/books`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/book/:tokenId", () => {
  it("returns analytics for a valid token", async () => {
    const res = await fetch(`${baseUrl}/api/book/tok-yes`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.bestBid).toBe(0.62);
  });

  it("returns 404 for unknown token", async () => {
    const res = await fetch(`${baseUrl}/api/book/unknown-token`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/book/:tokenId/ladder", () => {
  it("returns ladder for a valid token", async () => {
    const res = await fetch(`${baseUrl}/api/book/tok-yes/ladder`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("bids");
    expect(data).toHaveProperty("asks");
  });

  it("returns 404 for unknown token", async () => {
    const res = await fetch(`${baseUrl}/api/book/unknown/ladder`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/opportunities", () => {
  it("returns empty array when no opportunities", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });
});

describe("GET /api/ws/stats", () => {
  it("returns WebSocket stats", async () => {
    const res = await fetch(`${baseUrl}/api/ws/stats`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messagesReceived).toBe(100);
  });
});

describe("ClickHouse endpoints without DB", () => {
  it("GET /api/db/stats returns 503 when ClickHouse is not available", async () => {
    const res = await fetch(`${baseUrl}/api/db/stats`);
    expect(res.status).toBe(503);
  });

  it("POST /api/db/query returns 503 when ClickHouse is not available", async () => {
    const res = await fetch(`${baseUrl}/api/db/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("security headers", () => {
  it("includes helmet security headers", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    // Helmet sets X-Content-Type-Options
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("includes CORS headers on cross-origin requests", async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: "http://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});
