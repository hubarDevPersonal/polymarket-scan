import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { EventEmitter } from "events";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { fetchKlines, getMonthRange, getWeekRange, CoinSymbol, KlineInterval } from "./binance";
import { fetchHistoricalEventsWithPrices, fetchResolvedCryptoEvents, fetchPriceHistory, DateFilter } from "./history";
import { ClickHouseDb } from "./db/connection";
import { HistorySync } from "./db/sync";
import { dailyComparison, eventSummary, tableStats, executeQuery } from "./db/queries";

// ─── Input Validation ─────────────────────────────────────────────

const VALID_COINS = ["BTC", "ETH", "SOL"] as const;

function validateCoin(coin: string): string | null {
  const upper = coin.toUpperCase();
  return VALID_COINS.includes(upper as any) ? upper : null;
}

function validateYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return n >= 2020 && n <= 2030 ? n : null;
}

function validateMonth(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return n >= 1 && n <= 12 ? n : null;
}

export interface ScannerState {
  events: any[];
  selectedEventId: string | null;
  books: Map<string, any>; // tokenId -> analytics
  wsConnected: boolean;
  lastUpdate: number;
}

export function createServer(
  port: number,
  stateGetter: () => any,
  emitter: EventEmitter
) {
  const app = express();

  // ── Security middleware ──────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
      },
    },
  }));

  app.use(cors({
    origin: process.env.CORS_ORIGIN || true,
    methods: ["GET", "POST"],
  }));

  // General rate limiter: 200 requests per minute
  app.use(rateLimit({
    windowMs: 60_000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  }));

  // Strict rate limiter for heavy endpoints
  const heavyLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Rate limit exceeded for this endpoint" },
  });

  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use(express.json({ limit: "1mb" }));

  // API: list discovered events
  app.get("/api/events", (_req: Request, res: Response) => {
    const state = stateGetter();
    res.json(state.events || []);
  });

  // API: get analytics for all books of an event
  app.get("/api/event/:eventId/books", (req: Request, res: Response) => {
    const state = stateGetter();
    const eventId = req.params.eventId;
    const event = state.events?.find((e: any) => e.id === eventId);

    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    const books: any[] = [];
    for (const m of event.markets || []) {
      try {
        const tokenIds: string[] = JSON.parse(m.clobTokenIds || "[]");
        const outcomes: string[] = JSON.parse(m.outcomes || "[]");

        for (let i = 0; i < tokenIds.length; i++) {
          const analytics = state.bookAnalytics?.get(tokenIds[i]);
          books.push({
            marketId: m.id,
            question: m.question,
            outcome: outcomes[i] || `Outcome ${i}`,
            tokenId: tokenIds[i],
            analytics: analytics || null,
            volume: m.volumeNum || 0,
            liquidity: m.liquidityNum || 0,
          });
        }
      } catch { /* ignore unparseable markets */ }
    }

    res.json({
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
      },
      books,
    });
  });

  // API: get single book analytics
  app.get("/api/book/:tokenId", (req: Request, res: Response) => {
    const state = stateGetter();
    const analytics = state.bookAnalytics?.get(req.params.tokenId);
    if (!analytics) {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    res.json(analytics);
  });

  // API: full orderbook ladder for a token
  app.get("/api/book/:tokenId/ladder", (req: Request, res: Response) => {
    const state = stateGetter();
    const ladder = state.ladders?.get(req.params.tokenId);
    if (!ladder) {
      res.status(404).json({ error: "Ladder not found" });
      return;
    }
    res.json(ladder);
  });

  // API: active opportunities
  app.get("/api/opportunities", (_req: Request, res: Response) => {
    const state = stateGetter();
    res.json(state.opportunities || []);
  });

  // API: notifications
  app.get("/api/notifications", (req: Request, res: Response) => {
    const state = stateGetter();
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(state.getNotifications?.(limit) || []);
  });

  // API: mark notifications read
  app.post("/api/notifications/read", (_req: Request, res: Response) => {
    const state = stateGetter();
    state.markAllRead?.();
    res.json({ ok: true });
  });

  // API: detector config
  app.get("/api/config/detector", (_req: Request, res: Response) => {
    const state = stateGetter();
    res.json(state.detectorConfig || {});
  });

  app.post("/api/config/detector", (req: Request, res: Response) => {
    const state = stateGetter();
    state.updateDetectorConfig?.(req.body);
    res.json(state.detectorConfig || {});
  });

  // API: WS stats
  app.get("/api/ws/stats", (_req: Request, res: Response) => {
    const state = stateGetter();
    res.json(state.wsStats || {});
  });

  // API: Audit — recent critical events
  app.get("/api/audit/recent", async (req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.audit) {
      res.json([]);
      return;
    }
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const items = await state.audit.getRecent(limit);
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Notion sync — daily
  app.post("/api/notion/sync-daily", async (_req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.notionSync) {
      res.status(501).json({ error: "Notion sync not configured" });
      return;
    }
    try {
      const result = await state.notionSync.syncDaily();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Notion sync — weekly
  app.post("/api/notion/sync-weekly", async (_req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.notionSync) {
      res.status(501).json({ error: "Notion sync not configured" });
      return;
    }
    try {
      const result = await state.notionSync.syncWeekly();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Telegram status
  app.get("/api/telegram/status", (_req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.telegram) {
      res.json({ enabled: false, error: "Not configured" });
      return;
    }
    res.json({
      configured: state.telegram.isConfigured(),
      ...state.telegram.getStats(),
      config: {
        enabled: state.telegram.getConfig().enabled,
        chatId: state.telegram.getConfig().chatId ? "***" + state.telegram.getConfig().chatId.slice(-4) : "",
        minSeverity: state.telegram.getConfig().minSeverity,
        rateLimitMs: state.telegram.getConfig().rateLimitMs,
      },
    });
  });

  // API: Telegram test message
  app.post("/api/telegram/test", async (_req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.telegram) {
      res.status(501).json({ error: "Telegram not configured" });
      return;
    }
    try {
      const result = await state.telegram.sendTest();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Telegram config update
  app.post("/api/telegram/config", (req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.telegram) {
      res.status(501).json({ error: "Telegram not configured" });
      return;
    }
    state.telegram.updateConfig(req.body);
    res.json(state.telegram.getConfig());
  });

  // API: Telegram send summary now
  app.post("/api/telegram/summary", async (_req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.telegram) {
      res.status(501).json({ error: "Telegram not configured" });
      return;
    }
    try {
      const opps = state.opportunities || [];
      await state.telegram.sendSummary({
        activeOpps: opps.length,
        stableOpps: opps.filter((o: any) => o.status === "stable").length,
        events: state.events?.length || 0,
        tokens: state.bookAnalytics?.size || 0,
        wsConnected: state.wsConnected,
        topOpps: opps.slice(0, 5),
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: AlexBot alert client status
  app.get("/api/alerts/status", (_req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.alertClient) {
      res.json({ enabled: false, error: "Not configured" });
      return;
    }
    res.json({
      configured: state.alertClient.isConfigured(),
      ...state.alertClient.getStats(),
      config: state.alertClient.getConfig(),
    });
  });

  // API: Notion sync status
  app.get("/api/notion/status", (_req: Request, res: Response) => {
    const state = stateGetter();
    if (!state.notionSync) {
      res.json({ enabled: false, error: "Not configured" });
      return;
    }
    res.json(state.notionSync.getStatus());
  });

  // ─── Historical Comparison API ──────────────────────────────────

  // API: Binance klines for a coin + period
  app.get("/api/compare/binance/:coin", async (req: Request, res: Response) => {
    try {
      const coinMap: Record<string, CoinSymbol> = {
        btc: "BTCUSDT",
        eth: "ETHUSDT",
        sol: "SOLUSDT",
      };
      const symbol = coinMap[(req.params.coin as string).toLowerCase()];
      if (!symbol) {
        res.status(400).json({ error: "Invalid coin. Use btc, eth, or sol" });
        return;
      }

      const interval = (req.query.interval as KlineInterval) || "1d";
      const year = parseInt(req.query.year as string) || new Date().getFullYear();
      const month = parseInt(req.query.month as string) || 0;
      const week = req.query.week as string; // ISO date string for week

      let startTime: number | undefined;
      let endTime: number | undefined;

      if (month > 0) {
        const range = getMonthRange(year, month);
        startTime = range.startTime;
        endTime = range.endTime;
      } else if (week) {
        const range = getWeekRange(new Date(week));
        startTime = range.startTime;
        endTime = range.endTime;
      }

      const klines = await fetchKlines(symbol, interval, startTime, endTime, 1000);
      res.json({ symbol, interval, count: klines.length, klines });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Polymarket historical events for a coin
  app.get("/api/compare/polymarket/:coin", async (req: Request, res: Response) => {
    try {
      const coin = (req.params.coin as string).toUpperCase();
      if (!["BTC", "ETH", "SOL"].includes(coin)) {
        res.status(400).json({ error: "Invalid coin. Use btc, eth, or sol" });
        return;
      }

      const period = (req.query.period as "weekly" | "monthly") || "monthly";
      const events = await fetchHistoricalEventsWithPrices(coin, period);
      res.json({ coin, period, count: events.length, events });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: List available resolved events (lightweight, no price history)
  app.get("/api/compare/events/:coin", async (req: Request, res: Response) => {
    try {
      const coin = (req.params.coin as string).toUpperCase();
      if (!["BTC", "ETH", "SOL"].includes(coin)) {
        res.status(400).json({ error: "Invalid coin. Use btc, eth, or sol" });
        return;
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const year = parseInt(req.query.year as string) || 0;
      const month = parseInt(req.query.month as string) || 0;

      let dateFilter: DateFilter | undefined;
      if (year > 0 && month > 0) {
        dateFilter = { year, month };
      }

      const events = await fetchResolvedCryptoEvents(coin, limit, dateFilter);

      const simplified = events.map((e) => {
        const markets = e.markets.map((m) => {
          try {
            const outcomes: string[] = JSON.parse(m.outcomes || "[]");
            const prices: number[] = JSON.parse(m.outcomePrices || "[]");
            const tokenIds: string[] = JSON.parse(m.clobTokenIds || "[]");
            return outcomes.map((o, i) => ({
              outcome: o,
              tokenId: tokenIds[i] || "",
              finalPrice: prices[i] || 0,
              question: m.question,
            }));
          } catch {
            return [];
          }
        }).flat();

        return {
          eventId: e.id,
          title: e.title,
          endDate: e.endDate,
          startDate: e.startDate,
          markets,
        };
      });

      res.json({ coin, count: simplified.length, events: simplified });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Price history for a specific Polymarket outcome token
  app.get("/api/compare/price-history/:tokenId", async (req: Request, res: Response) => {
    try {
      const tokenId = req.params.tokenId as string;
      const interval = (req.query.interval as string) || "all";
      const startTs = req.query.startTs ? parseInt(req.query.startTs as string) : undefined;
      const endTs = req.query.endTs ? parseInt(req.query.endTs as string) : undefined;

      const history = await fetchPriceHistory(tokenId, startTs, endTs, interval);
      res.json({ tokenId, count: history.length, history });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── ClickHouse Historical Database API ─────────────────────────────

  // Trigger a sync for a coin + month
  app.post("/api/db/sync", heavyLimiter, async (req: Request, res: Response) => {
    const state = stateGetter();
    const db: ClickHouseDb | null = state.clickhouseDb;
    const sync: HistorySync | null = state.historySync;

    if (!db || !db.ready || !sync) {
      res.status(503).json({ error: "ClickHouse not available" });
      return;
    }

    const { coin, year, month, force } = req.body || {};
    if (!coin || !year || !month) {
      res.status(400).json({ error: "Missing coin, year, or month" });
      return;
    }

    if (sync.isRunning()) {
      res.status(409).json({ error: "Sync already in progress" });
      return;
    }

    // Run sync asynchronously and stream progress via SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (type: string, data: any) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await sync.sync(
        { coin, year: parseInt(year), month: parseInt(month), force: force === true },
        (progress) => sendEvent("progress", progress),
      );
      sendEvent("done", result);
    } catch (err: any) {
      sendEvent("error", { error: err.message });
    }

    res.end();
  });

  // Get sync log
  app.get("/api/db/sync/status", async (_req: Request, res: Response) => {
    const state = stateGetter();
    const sync: HistorySync | null = state.historySync;
    if (!sync) {
      res.status(503).json({ error: "ClickHouse not available" });
      return;
    }
    try {
      const log = await sync.getSyncLog();
      res.json({ running: sync.isRunning(), log });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get events from DB
  app.get("/api/db/events", async (req: Request, res: Response) => {
    const state = stateGetter();
    const db: ClickHouseDb | null = state.clickhouseDb;
    if (!db || !db.ready) {
      res.status(503).json({ error: "ClickHouse not available" });
      return;
    }
    try {
      const coin = (req.query.coin as string) || "BTC";
      const year = parseInt(req.query.year as string) || 2026;
      const month = parseInt(req.query.month as string) || 1;
      const events = await eventSummary(db, coin, year, month);
      res.json({ events });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Daily comparison query
  app.get("/api/db/compare/daily", async (req: Request, res: Response) => {
    const state = stateGetter();
    const db: ClickHouseDb | null = state.clickhouseDb;
    if (!db || !db.ready) {
      res.status(503).json({ error: "ClickHouse not available" });
      return;
    }
    try {
      const coin = (req.query.coin as string) || "BTC";
      const year = parseInt(req.query.year as string) || 2026;
      const month = parseInt(req.query.month as string) || 1;
      const rows = await dailyComparison(db, coin, year, month);
      res.json({ rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Execute ad-hoc SQL (read-only)
  app.post("/api/db/query", heavyLimiter, async (req: Request, res: Response) => {
    const state = stateGetter();
    const db: ClickHouseDb | null = state.clickhouseDb;
    if (!db || !db.ready) {
      res.status(503).json({ error: "ClickHouse not available" });
      return;
    }
    try {
      const sql = req.body?.sql;
      if (!sql || typeof sql !== "string") {
        res.status(400).json({ error: "Missing sql field" });
        return;
      }
      const result = await executeQuery(db, sql);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // DB stats
  app.get("/api/db/stats", async (_req: Request, res: Response) => {
    const state = stateGetter();
    const db: ClickHouseDb | null = state.clickhouseDb;
    if (!db || !db.ready) {
      res.status(503).json({ error: "ClickHouse not available", ready: false });
      return;
    }
    try {
      const stats = await tableStats(db);
      res.json({ ready: true, stats });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // SSE: real-time updates stream
  app.get("/api/stream", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (type: string, data: any) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial state
    const state = stateGetter();
    sendEvent("init", {
      wsConnected: state.wsConnected,
      eventCount: state.events?.length || 0,
    });

    // Forward events
    const onUpdate = (data: any) => sendEvent("update", data);
    const onBook = (data: any) => sendEvent("book", data);
    const onStatus = (data: any) => sendEvent("status", data);
    const onOpportunity = (data: any) => sendEvent("opportunity", data);
    const onNotification = (data: any) => sendEvent("notification", data);

    emitter.on("update", onUpdate);
    emitter.on("book", onBook);
    emitter.on("status", onStatus);
    emitter.on("opportunity", onOpportunity);
    emitter.on("notification", onNotification);

    req.on("close", () => {
      emitter.off("update", onUpdate);
      emitter.off("book", onBook);
      emitter.off("status", onStatus);
      emitter.off("opportunity", onOpportunity);
      emitter.off("notification", onNotification);
    });
  });

  // API: health check
  app.get("/api/health", (_req: Request, res: Response) => {
    const state = stateGetter();
    const mem = process.memoryUsage();
    res.json({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      wsConnected: state.wsConnected,
      eventsLoaded: state.events?.length || 0,
      booksTracked: state.bookAnalytics?.size || 0,
      clickhouse: state.clickhouseDb?.ready ?? false,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
    });
  });

  const server = app.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
  });

  return { app, server };
}
