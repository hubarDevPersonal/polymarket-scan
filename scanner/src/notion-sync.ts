import { Client } from "@notionhq/client";
import { BookAnalytics } from "./analytics";
import { Opportunity } from "./detector";
import { Notification, NotificationManager } from "./notifications";
import { GammaEvent } from "./gamma";

// ─── Config ────────────────────────────────────────────────────────

export interface NotionSyncConfig {
  notionToken: string;
  dailyDatabaseId: string;
  weeklyDatabaseId: string;
  enabled: boolean;
  dailySyncHour: number; // 0-23, default 0
  weeklySyncDay: number; // 0=Sun..6=Sat, default 0
}

// ─── State snapshot interface ──────────────────────────────────────

export interface ScannerStateSnapshot {
  events: GammaEvent[];
  bookAnalytics: Map<string, BookAnalytics>;
  opportunities: Opportunity[];
  wsStats: {
    connected: boolean;
    messageCount: number;
    lastMessageAt: number;
    subscribedTokens: number;
  };
  notifications: Notification[];
}

// ─── Daily summary ─────────────────────────────────────────────────

export interface DailySummary {
  date: string;
  totalEvents: number;
  totalTokens: number;
  activeOpportunities: number;
  newOpportunities: number;
  stableOpportunities: number;
  vanishedOpportunities: number;
  thinnedOpportunities: number;
  topSpreadBps: number;
  avgSpreadBps: number;
  totalDepthUsd: number;
  wsConnected: boolean;
  wsMessages: number;
  alertCount: number;
  topOpportunities: Opportunity[];
  notableAlerts: Notification[];
}

// ─── Weekly summary ────────────────────────────────────────────────

export interface WeeklySummary {
  weekLabel: string;
  weekStart: string;
  weekEnd: string;
  avgDailyEvents: number;
  avgDailyTokens: number;
  peakOpportunities: number;
  totalNewOpportunities: number;
  totalVanished: number;
  avgSpreadBps: number;
  peakSpreadBps: number;
  avgTotalDepthUsd: number;
  wsUptimePct: number;
  totalAlerts: number;
  daysSynced: number;
}

// ─── Sync result ───────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  pageId?: string;
  pageUrl?: string;
  error?: string;
}

// ─── NotionSync class ──────────────────────────────────────────────

export class NotionSync {
  private client: Client;
  private config: NotionSyncConfig;
  private stateGetter: () => ScannerStateSnapshot;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private lastDailySyncDate: string | null = null;
  private lastWeeklySyncDate: string | null = null;
  private lastDailyResult: SyncResult | null = null;
  private lastWeeklyResult: SyncResult | null = null;

  // Notification counters since last daily sync
  private dailyCounts = {
    opportunity_new: 0,
    opportunity_stable: 0,
    opportunity_vanished: 0,
    opportunity_thinned: 0,
    total: 0,
  };

  constructor(
    config: NotionSyncConfig,
    stateGetter: () => ScannerStateSnapshot,
    notificationManager: NotificationManager
  ) {
    this.config = config;
    this.stateGetter = stateGetter;
    this.client = new Client({ auth: config.notionToken });

    // Track notifications as they arrive
    notificationManager.on("notification", (n: Notification) => {
      this.dailyCounts.total++;
      if (n.type in this.dailyCounts) {
        (this.dailyCounts as any)[n.type]++;
      }
    });
  }

  // ── Scheduler ──────────────────────────────────────────────────

  startScheduler() {
    if (this.schedulerTimer) return;
    console.log(
      `[notion-sync] scheduler started (daily at ${this.config.dailySyncHour}:00, weekly on day ${this.config.weeklySyncDay})`
    );
    this.schedulerTimer = setInterval(() => this.checkSchedule(), 60_000);
  }

  stopScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private checkSchedule() {
    if (!this.config.enabled) return;

    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    // Daily sync
    if (hour === this.config.dailySyncHour && this.lastDailySyncDate !== todayStr) {
      this.lastDailySyncDate = todayStr;
      this.syncDaily().catch((err) =>
        console.error(`[notion-sync] daily sync error: ${err.message}`)
      );
    }

    // Weekly sync (1 hour after daily)
    if (
      dayOfWeek === this.config.weeklySyncDay &&
      hour === this.config.dailySyncHour + 1 &&
      this.lastWeeklySyncDate !== todayStr
    ) {
      this.lastWeeklySyncDate = todayStr;
      this.syncWeekly().catch((err) =>
        console.error(`[notion-sync] weekly sync error: ${err.message}`)
      );
    }
  }

  // ── Public API ─────────────────────────────────────────────────

  async syncDaily(): Promise<SyncResult> {
    try {
      console.log("[notion-sync] running daily sync...");
      const summary = this.aggregateDailySummary();
      const result = await this.createDailyPage(summary);
      this.resetDailyCounters();
      this.lastDailyResult = result;
      console.log(`[notion-sync] daily sync complete: ${result.pageUrl}`);
      return result;
    } catch (err: any) {
      const result: SyncResult = { success: false, error: err.message };
      this.lastDailyResult = result;
      console.error(`[notion-sync] daily sync failed: ${err.message}`);
      return result;
    }
  }

  async syncWeekly(): Promise<SyncResult> {
    try {
      console.log("[notion-sync] running weekly sync...");
      const summary = await this.aggregateWeeklySummary();
      const result = await this.createWeeklyPage(summary);
      this.lastWeeklyResult = result;
      console.log(`[notion-sync] weekly sync complete: ${result.pageUrl}`);
      return result;
    } catch (err: any) {
      const result: SyncResult = { success: false, error: err.message };
      this.lastWeeklyResult = result;
      console.error(`[notion-sync] weekly sync failed: ${err.message}`);
      return result;
    }
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      dailySyncHour: this.config.dailySyncHour,
      weeklySyncDay: this.config.weeklySyncDay,
      lastDailySyncDate: this.lastDailySyncDate,
      lastWeeklySyncDate: this.lastWeeklySyncDate,
      lastDailyResult: this.lastDailyResult,
      lastWeeklyResult: this.lastWeeklyResult,
      pendingCounts: { ...this.dailyCounts },
    };
  }

  // ── Aggregation ────────────────────────────────────────────────

  private aggregateDailySummary(): DailySummary {
    const state = this.stateGetter();
    const today = new Date().toISOString().split("T")[0];

    // Spread stats across all books
    let spreadSum = 0;
    let spreadCount = 0;
    let totalDepth = 0;

    for (const [, analytics] of state.bookAnalytics) {
      if (analytics.topOfBook.spreadBps) {
        spreadSum += parseFloat(analytics.topOfBook.spreadBps);
        spreadCount++;
      }
      totalDepth += parseFloat(analytics.depth50bps.totalDepth);
    }

    const topSpread =
      state.opportunities.length > 0
        ? Math.max(...state.opportunities.map((o) => o.spreadBps))
        : 0;

    const notableAlerts = state.notifications
      .filter((n) => n.severity !== "info")
      .slice(0, 20);

    return {
      date: today,
      totalEvents: state.events.length,
      totalTokens: state.bookAnalytics.size,
      activeOpportunities: state.opportunities.length,
      newOpportunities: this.dailyCounts.opportunity_new,
      stableOpportunities: this.dailyCounts.opportunity_stable,
      vanishedOpportunities: this.dailyCounts.opportunity_vanished,
      thinnedOpportunities: this.dailyCounts.opportunity_thinned,
      topSpreadBps: topSpread,
      avgSpreadBps: spreadCount > 0 ? Math.round(spreadSum / spreadCount) : 0,
      totalDepthUsd: Math.round(totalDepth * 100) / 100,
      wsConnected: state.wsStats.connected,
      wsMessages: state.wsStats.messageCount,
      alertCount: this.dailyCounts.total,
      topOpportunities: state.opportunities.slice(0, 10),
      notableAlerts,
    };
  }

  private async aggregateWeeklySummary(): Promise<WeeklySummary> {
    const now = new Date();
    // Find the most recent Sunday
    const daysSinceSunday = now.getDay();
    const sunday = new Date(now);
    sunday.setDate(now.getDate() - daysSinceSunday);
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);

    const weekStart = sunday.toISOString().split("T")[0];
    const weekEnd = saturday.toISOString().split("T")[0];

    // Query daily pages for this week via dataSources API (v5)
    const response = await this.client.dataSources.query({
      data_source_id: this.config.dailyDatabaseId,
      filter: {
        and: [
          { property: "Report Date", date: { on_or_after: weekStart } },
          { property: "Report Date", date: { on_or_before: weekEnd } },
        ],
      },
      sorts: [{ property: "Report Date", direction: "ascending" }],
    } as any);

    const days = response.results as any[];
    const n = days.length || 1;

    let totalEvents = 0;
    let totalTokens = 0;
    let peakOpps = 0;
    let totalNew = 0;
    let totalVanished = 0;
    let spreadSum = 0;
    let peakSpread = 0;
    let depthSum = 0;
    let wsUpDays = 0;
    let totalAlerts = 0;

    for (const page of days) {
      const p = page.properties;
      const num = (prop: any) => prop?.number ?? 0;
      const chk = (prop: any) => prop?.checkbox ?? false;

      totalEvents += num(p["Total Events"]);
      totalTokens += num(p["Total Tokens"]);
      peakOpps = Math.max(peakOpps, num(p["Active Opportunities"]));
      totalNew += num(p["New Opportunities"]);
      totalVanished += num(p["Vanished Opportunities"]);
      spreadSum += num(p["Avg Spread (bps)"]);
      peakSpread = Math.max(peakSpread, num(p["Top Spread (bps)"]));
      depthSum += num(p["Total Depth (USD)"]);
      if (chk(p["WS Connected"])) wsUpDays++;
      totalAlerts += num(p["Alert Count"]);
    }

    return {
      weekLabel: `Week of ${weekStart}`,
      weekStart,
      weekEnd,
      avgDailyEvents: Math.round(totalEvents / n),
      avgDailyTokens: Math.round(totalTokens / n),
      peakOpportunities: peakOpps,
      totalNewOpportunities: totalNew,
      totalVanished,
      avgSpreadBps: Math.round(spreadSum / n),
      peakSpreadBps: peakSpread,
      avgTotalDepthUsd: Math.round((depthSum / n) * 100) / 100,
      wsUptimePct: Math.round((wsUpDays / n) * 100),
      totalAlerts,
      daysSynced: days.length,
    };
  }

  // ── Notion page creation ───────────────────────────────────────

  private async createDailyPage(s: DailySummary): Promise<SyncResult> {
    const response = await this.client.pages.create({
      parent: { database_id: this.config.dailyDatabaseId },
      properties: {
        Date: { title: [{ text: { content: s.date } }] },
        "Report Date": { date: { start: s.date } },
        "Total Events": { number: s.totalEvents },
        "Total Tokens": { number: s.totalTokens },
        "Active Opportunities": { number: s.activeOpportunities },
        "New Opportunities": { number: s.newOpportunities },
        "Stable Opportunities": { number: s.stableOpportunities },
        "Vanished Opportunities": { number: s.vanishedOpportunities },
        "Thinned Opportunities": { number: s.thinnedOpportunities },
        "Top Spread (bps)": { number: s.topSpreadBps },
        "Avg Spread (bps)": { number: s.avgSpreadBps },
        "Total Depth (USD)": { number: s.totalDepthUsd },
        "WS Connected": { checkbox: s.wsConnected },
        "WS Messages": { number: s.wsMessages },
        "Alert Count": { number: s.alertCount },
        Status: { select: { name: "Success" } },
      },
      children: this.buildDailyContent(s),
    });

    return {
      success: true,
      pageId: response.id,
      pageUrl: (response as any).url,
    };
  }

  private async createWeeklyPage(s: WeeklySummary): Promise<SyncResult> {
    const response = await this.client.pages.create({
      parent: { database_id: this.config.weeklyDatabaseId },
      properties: {
        Week: { title: [{ text: { content: s.weekLabel } }] },
        "Week Start": { date: { start: s.weekStart } },
        "Week End": { date: { start: s.weekEnd } },
        "Avg Daily Events": { number: s.avgDailyEvents },
        "Avg Daily Tokens": { number: s.avgDailyTokens },
        "Peak Opportunities": { number: s.peakOpportunities },
        "Total New Opportunities": { number: s.totalNewOpportunities },
        "Total Vanished": { number: s.totalVanished },
        "Avg Spread (bps)": { number: s.avgSpreadBps },
        "Peak Spread (bps)": { number: s.peakSpreadBps },
        "Avg Total Depth (USD)": { number: s.avgTotalDepthUsd },
        "WS Uptime %": { number: s.wsUptimePct },
        "Total Alerts": { number: s.totalAlerts },
        "Days Synced": { number: s.daysSynced },
        Status: {
          select: { name: s.daysSynced >= 7 ? "Complete" : "Partial" },
        },
      },
      children: this.buildWeeklyContent(s),
    });

    return {
      success: true,
      pageId: response.id,
      pageUrl: (response as any).url,
    };
  }

  // ── Content builders ───────────────────────────────────────────

  private buildDailyContent(s: DailySummary): any[] {
    const blocks: any[] = [];

    // Summary heading
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Summary" } }],
      },
    });

    blocks.push(
      this.bullet(
        `Events tracked: ${s.totalEvents} | Tokens: ${s.totalTokens}`
      )
    );
    blocks.push(
      this.bullet(
        `Active opportunities: ${s.activeOpportunities} | New: ${s.newOpportunities} | Stable: ${s.stableOpportunities}`
      )
    );
    blocks.push(
      this.bullet(
        `Vanished: ${s.vanishedOpportunities} | Thinned: ${s.thinnedOpportunities}`
      )
    );
    blocks.push(
      this.bullet(
        `Top spread: ${s.topSpreadBps} bps | Avg spread: ${s.avgSpreadBps} bps`
      )
    );
    blocks.push(
      this.bullet(`Total depth (50bps): $${s.totalDepthUsd.toFixed(2)}`)
    );
    blocks.push(
      this.bullet(
        `WS: ${s.wsConnected ? "Connected" : "Disconnected"} | Messages: ${s.wsMessages.toLocaleString()}`
      )
    );
    blocks.push(this.bullet(`Total alerts: ${s.alertCount}`));

    // Top opportunities
    if (s.topOpportunities.length > 0) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [
            { type: "text", text: { content: "Top Opportunities" } },
          ],
        },
      });

      for (const o of s.topOpportunities) {
        const label = o.label || o.tokenId.substring(0, 20);
        blocks.push(
          this.bullet(
            `${label} — ${o.spreadBps} bps | Bid ${o.bestBid} / Ask ${o.bestAsk} | Depth $${o.bidDepthUsd.toFixed(0)}/$${o.askDepthUsd.toFixed(0)} | ${o.status}`
          )
        );
      }
    }

    // Notable alerts
    if (s.notableAlerts.length > 0) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: "Notable Alerts" } }],
        },
      });

      for (const a of s.notableAlerts.slice(0, 10)) {
        blocks.push(
          this.bullet(
            `[${a.severity.toUpperCase()}] ${a.title}: ${a.body}`
          )
        );
      }
    }

    return blocks;
  }

  private buildWeeklyContent(s: WeeklySummary): any[] {
    const blocks: any[] = [];

    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Weekly Summary" } }],
      },
    });

    blocks.push(
      this.bullet(`Period: ${s.weekStart} to ${s.weekEnd} (${s.daysSynced} days synced)`)
    );
    blocks.push(
      this.bullet(
        `Avg daily events: ${s.avgDailyEvents} | Avg daily tokens: ${s.avgDailyTokens}`
      )
    );
    blocks.push(
      this.bullet(
        `Peak opportunities: ${s.peakOpportunities} | Total new: ${s.totalNewOpportunities} | Total vanished: ${s.totalVanished}`
      )
    );
    blocks.push(
      this.bullet(
        `Avg spread: ${s.avgSpreadBps} bps | Peak spread: ${s.peakSpreadBps} bps`
      )
    );
    blocks.push(
      this.bullet(`Avg total depth: $${s.avgTotalDepthUsd.toFixed(2)}`)
    );
    blocks.push(this.bullet(`WS uptime: ${s.wsUptimePct}%`));
    blocks.push(this.bullet(`Total alerts: ${s.totalAlerts}`));

    return blocks;
  }

  private bullet(text: string) {
    return {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [{ type: "text", text: { content: text } }],
      },
    };
  }

  // ── Helpers ────────────────────────────────────────────────────

  private resetDailyCounters() {
    this.dailyCounts = {
      opportunity_new: 0,
      opportunity_stable: 0,
      opportunity_vanished: 0,
      opportunity_thinned: 0,
      total: 0,
    };
  }
}
