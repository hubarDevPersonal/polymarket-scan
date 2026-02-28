import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── Config ────────────────────────────────────────────────────────

export interface AuditConfig {
  endpoint?: string; // DynamoDB Local URL (omit for real AWS)
  table: string;
  region: string;
  enabled: boolean;
}

// ─── Audit event types (critical only) ─────────────────────────────

export type AuditEventType =
  | "OPP_STABLE"
  | "OPP_WIDE"
  | "WS_DOWN"
  | "WS_STALL"
  | "DISCOVERY"
  | "NOTION_SYNC"
  | "ERROR";

const TTL_DAYS = 30;

// ─── AuditLogger ───────────────────────────────────────────────────

export class AuditLogger {
  private doc: DynamoDBDocumentClient;
  private raw: DynamoDBClient;
  private table: string;
  private enabled: boolean;
  private ready = false;

  constructor(config: AuditConfig) {
    this.table = config.table;
    this.enabled = config.enabled;

    const opts: any = { region: config.region };
    if (config.endpoint) {
      opts.endpoint = config.endpoint;
      // DynamoDB Local requires dummy credentials
      opts.credentials = {
        accessKeyId: "local",
        secretAccessKey: "local",
      };
    }

    this.raw = new DynamoDBClient(opts);
    this.doc = DynamoDBDocumentClient.from(this.raw, {
      marshallOptions: { removeUndefinedValues: true },
    });

    if (this.enabled) {
      this.initWithRetry(5, 3000);
    }
  }

  // ── Public API ─────────────────────────────────────────────────

  async log(
    type: AuditEventType,
    severity: string,
    summary: string,
    data?: Record<string, any>
  ): Promise<void> {
    if (!this.enabled) return;
    if (!this.ready) return; // skip writes until table is confirmed

    const now = new Date();
    const ts = now.toISOString();
    const ttl = Math.floor(now.getTime() / 1000) + TTL_DAYS * 86400;

    // Keep data small — strip large fields
    const slim = data ? slimDown(data) : undefined;

    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: type,
            sk: `${ts}#${slim?.tokenId || slim?.label || "system"}`,
            severity,
            summary,
            data: slim,
            ttl,
          },
        })
      );
    } catch (err: any) {
      console.error(`[audit] write error: ${err.message}`);
    }
  }

  async getRecent(limit = 50): Promise<any[]> {
    if (!this.enabled) return [];

    const types: AuditEventType[] = [
      "OPP_STABLE",
      "OPP_WIDE",
      "WS_DOWN",
      "WS_STALL",
      "DISCOVERY",
      "NOTION_SYNC",
      "ERROR",
    ];

    const results: any[] = [];

    // Query each partition (small number of types, fast)
    for (const pk of types) {
      try {
        const resp = await this.doc.send(
          new QueryCommand({
            TableName: this.table,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": pk },
            ScanIndexForward: false, // newest first
            Limit: Math.ceil(limit / types.length) + 2,
          })
        );
        if (resp.Items) results.push(...resp.Items);
      } catch {
        // ignore per-partition errors
      }
    }

    // Sort all by sk descending and trim
    results.sort((a, b) => (b.sk as string).localeCompare(a.sk as string));
    return results.slice(0, limit);
  }

  isReady() {
    return this.ready;
  }

  // ── Init with retry (wait for DynamoDB to be ready) ──────────

  private async initWithRetry(maxRetries: number, delayMs: number) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.ensureTable();
        return;
      } catch (err: any) {
        const isConnErr = err.message?.includes("ECONNREFUSED") || err.message?.includes("ETIMEDOUT");
        if (isConnErr && attempt < maxRetries) {
          console.log(`[audit] DynamoDB not ready, retry ${attempt}/${maxRetries} in ${delayMs / 1000}s...`);
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          console.error(`[audit] table init error after ${attempt} attempts: ${err.message}`);
          return;
        }
      }
    }
  }

  // ── Table setup ────────────────────────────────────────────────

  private async ensureTable() {
    try {
      await this.raw.send(
        new DescribeTableCommand({ TableName: this.table })
      );
      this.ready = true;
      console.log(`[audit] table "${this.table}" exists`);
    } catch (err: any) {
      if (
        err.name === "ResourceNotFoundException" ||
        err.__type?.includes("ResourceNotFoundException")
      ) {
        await this.createTable();
      } else {
        throw err;
      }
    }
  }

  private async createTable() {
    console.log(`[audit] creating table "${this.table}"...`);
    await this.raw.send(
      new CreateTableCommand({
        TableName: this.table,
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      })
    );
    this.ready = true;
    console.log(`[audit] table created`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Keep only small, relevant fields — no full orderbooks */
function slimDown(data: Record<string, any>): Record<string, any> {
  const slim: Record<string, any> = {};

  // Copy safe scalar fields
  const allow = [
    "tokenId",
    "label",
    "spreadBps",
    "bestBid",
    "bestAsk",
    "mid",
    "bidDepthUsd",
    "askDepthUsd",
    "stabilityCount",
    "recentTrades",
    "status",
    "pageUrl",
    "error",
    "eventCount",
    "tokenCount",
    "connected",
    "messageCount",
  ];

  for (const key of allow) {
    if (key in data && data[key] !== undefined) {
      slim[key] = data[key];
    }
  }

  return slim;
}
