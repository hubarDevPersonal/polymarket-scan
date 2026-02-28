const GAMMA_BASE = "https://gamma-api.polymarket.com";

export interface GammaToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

export interface GammaMarket {
  id: string;
  condition_id: string;
  question_id: string;
  question: string;
  slug: string;
  outcomes: string; // JSON string e.g. '["Yes","No"]'
  outcomePrices: string; // JSON string e.g. '[0.55,0.45]'
  clobTokenIds: string; // JSON string e.g. '["id1","id2"]'
  active: boolean;
  closed: boolean;
  volume: string;
  volumeNum: number;
  liquidity: string;
  liquidityNum: number;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
  spread: number;
}

export interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  markets: GammaMarket[];
  volume: number;
  volumeNum: number;
  liquidity: number;
  liquidityNum: number;
  commentCount: number;
}

/** Fetch crypto events from Gamma API */
export async function fetchCryptoEvents(limit = 50): Promise<GammaEvent[]> {
  const url = `${GAMMA_BASE}/events?tag=crypto&closed=false&active=true&limit=${limit}&order=volume24hr&ascending=false`;
  console.log(`[gamma] fetching: ${url}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma events failed: ${res.status}`);
  return res.json() as Promise<GammaEvent[]>;
}

/** Filter events matching "hit price" pattern */
export function filterHitPriceEvents(events: GammaEvent[]): GammaEvent[] {
  const patterns = [
    /what price will .+ hit/i,
    /will .+ hit \$/i,
    /will .+ reach \$/i,
    /hit price/i,
    /price.*will.*hit/i,
  ];

  return events.filter((e) =>
    patterns.some((p) => p.test(e.title) || p.test(e.slug))
  );
}

/** Extract all token IDs from an event's markets */
export function extractTokenIds(event: GammaEvent): string[] {
  const ids: string[] = [];
  for (const m of event.markets) {
    try {
      const clobIds: string[] = JSON.parse(m.clobTokenIds);
      ids.push(...clobIds);
    } catch {
      // skip malformed
    }
  }
  return ids;
}

/** Parse market outcomes with their token IDs */
export interface MarketOutcome {
  marketId: string;
  question: string;
  outcome: string;
  tokenId: string;
  price: number;
  volume: number;
  liquidity: number;
}

export function parseMarketOutcomes(event: GammaEvent): MarketOutcome[] {
  const results: MarketOutcome[] = [];

  for (const m of event.markets) {
    try {
      const outcomes: string[] = JSON.parse(m.outcomes || "[]");
      const prices: number[] = JSON.parse(m.outcomePrices || "[]");
      const tokenIds: string[] = JSON.parse(m.clobTokenIds || "[]");

      for (let i = 0; i < outcomes.length; i++) {
        results.push({
          marketId: m.id,
          question: m.question,
          outcome: outcomes[i],
          tokenId: tokenIds[i] || "",
          price: prices[i] || 0,
          volume: m.volumeNum || 0,
          liquidity: m.liquidityNum || 0,
        });
      }
    } catch {
      // skip malformed market
    }
  }

  return results;
}

/** Search for events by query */
export async function searchEvents(query: string, limit = 20): Promise<GammaEvent[]> {
  const url = `${GAMMA_BASE}/events?closed=false&active=true&limit=${limit}&title_contains=${encodeURIComponent(query)}`;
  console.log(`[gamma] searching: ${url}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma search failed: ${res.status}`);
  return res.json() as Promise<GammaEvent[]>;
}
