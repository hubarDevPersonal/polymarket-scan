import { describe, it, expect } from "vitest";
import { executeQuery } from "../db/queries";

// We can't test the actual ClickHouse queries without a running instance,
// but we CAN test the SQL validation and safety checks in executeQuery.

// Mock ClickHouseDb to avoid needing a real connection
const mockDb = {
  ready: true,
  query: async (sql: string) => {
    // Return empty rows with column names extracted from a simple parse
    return [{ mock: true }];
  },
  close: async () => {},
} as any;

describe("executeQuery — SQL validation", () => {
  it("allows SELECT queries", async () => {
    const result = await executeQuery(mockDb, "SELECT 1 AS value");
    expect(result.rows).toHaveLength(1);
    expect(result.columns).toContain("mock");
  });

  it("allows WITH ... SELECT queries", async () => {
    const result = await executeQuery(mockDb, "WITH cte AS (SELECT 1) SELECT * FROM cte");
    expect(result.rows).toHaveLength(1);
  });

  it("allows SHOW queries", async () => {
    const result = await executeQuery(mockDb, "SHOW TABLES");
    expect(result.rows).toHaveLength(1);
  });

  it("allows DESCRIBE queries", async () => {
    const result = await executeQuery(mockDb, "DESCRIBE scanner.events");
    expect(result.rows).toHaveLength(1);
  });

  it("rejects INSERT queries", async () => {
    await expect(
      executeQuery(mockDb, "INSERT INTO scanner.events VALUES ('x')")
    ).rejects.toThrow("Only SELECT");
  });

  it("rejects DROP queries", async () => {
    await expect(
      executeQuery(mockDb, "SELECT 1; DROP TABLE scanner.events")
    ).rejects.toThrow("blocked keywords");
  });

  it("rejects DELETE queries", async () => {
    await expect(
      executeQuery(mockDb, "DELETE FROM scanner.events WHERE 1=1")
    ).rejects.toThrow("Only SELECT");
  });

  it("rejects ALTER queries", async () => {
    await expect(
      executeQuery(mockDb, "ALTER TABLE scanner.events DROP COLUMN title")
    ).rejects.toThrow("Only SELECT");
  });

  it("rejects CREATE queries", async () => {
    await expect(
      executeQuery(mockDb, "CREATE TABLE hack (id UInt32) ENGINE = Memory")
    ).rejects.toThrow("Only SELECT");
  });

  it("rejects TRUNCATE queries", async () => {
    await expect(
      executeQuery(mockDb, "TRUNCATE TABLE scanner.events")
    ).rejects.toThrow("Only SELECT");
  });

  it("rejects queries with embedded DROP in SELECT", async () => {
    await expect(
      executeQuery(mockDb, "SELECT * FROM events WHERE DROP TABLE events")
    ).rejects.toThrow("blocked keywords");
  });

  it("handles leading whitespace", async () => {
    const result = await executeQuery(mockDb, "   SELECT 1");
    expect(result.rows).toHaveLength(1);
  });

  it("handles case-insensitive keywords", async () => {
    const result = await executeQuery(mockDb, "select 1 as val");
    expect(result.rows).toHaveLength(1);
  });

  it("rejects case-insensitive dangerous keywords", async () => {
    await expect(
      executeQuery(mockDb, "select 1; drop table events")
    ).rejects.toThrow("blocked keywords");
  });
});
