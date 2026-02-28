import { BookSnapshot } from "./orderbook";

const CLOB_BASE = "https://clob.polymarket.com";

/** Fetch orderbook snapshot for a single token */
export async function fetchBook(tokenId: string): Promise<BookSnapshot> {
  const url = `${CLOB_BASE}/book?token_id=${tokenId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Book fetch failed for ${tokenId}: ${res.status}`);
  return res.json() as Promise<BookSnapshot>;
}

/** Fetch orderbook snapshots for multiple tokens (batch) */
export async function fetchBooks(tokenIds: string[]): Promise<BookSnapshot[]> {
  // The batch endpoint takes an array of objects
  const body = tokenIds.map((id) => ({ token_id: id }));

  const res = await fetch(`${CLOB_BASE}/books`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Fall back to individual requests
    console.warn(`[clob] batch books failed (${res.status}), falling back to individual`);
    return fetchBooksIndividual(tokenIds);
  }

  return res.json() as Promise<BookSnapshot[]>;
}

async function fetchBooksIndividual(tokenIds: string[]): Promise<BookSnapshot[]> {
  const results: BookSnapshot[] = [];
  // Rate limit: fetch 5 at a time with small delay
  const batchSize = 5;

  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      fetchBook(id).catch((err) => {
        console.warn(`[clob] failed to fetch book for ${id}: ${err.message}`);
        return null;
      })
    );

    const snapshots = await Promise.all(promises);
    for (const s of snapshots) {
      if (s) results.push(s);
    }

    if (i + batchSize < tokenIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}

/** Fetch midpoint price */
export async function fetchMidpoint(tokenId: string): Promise<string | null> {
  try {
    const res = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.mid ?? data.mid_price ?? null;
  } catch {
    return null;
  }
}
