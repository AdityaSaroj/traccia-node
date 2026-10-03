/**
 * Process-level singleton that holds the active pricing table.
 */

import { PricingRates, PricingTable, DEFAULT_PRICING } from '../config/pricing-config';

export class CostResolver {
  private table: PricingTable;
  private source: string;
  private generatedAt: string;

  constructor(
    pricingTable: PricingTable,
    source: string = 'bundled',
    generatedAt: string = 'unknown'
  ) {
    this.table = pricingTable;
    this.source = source;
    this.generatedAt = generatedAt;
  }

  public get pricingTable(): PricingTable {
    return this.table;
  }

  public get getSource(): string {
    return this.source;
  }

  public get getGeneratedAt(): string {
    return this.generatedAt;
  }

  /**
   * Replace the active pricing table (e.g. after a background refresh).
   */
  public update(
    pricingTable: PricingTable,
    source?: string,
    generatedAt?: string
  ): void {
    this.table = pricingTable;
    if (source) {
      this.source = source;
    }
    if (generatedAt) {
      this.generatedAt = generatedAt;
    }
  }

  /**
   * Return the estimated cost in USD, or undefined if the model has no pricing entry.
   * promptTokens is uncached input. Cache read and cache write use their own rates.
   */
  public compute(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ): number | undefined {
    return this.computeDetailed(model, promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens)?.cost;
  }

  public computeDetailed(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ): { cost: number; cacheFallback: boolean } | undefined {
    const matched = this.lookupPrice(model);
    if (!matched) {
      return undefined;
    }

    const [, pricing] = matched;
    const inputRate = rate(pricing, "inputCost", "prompt");
    const outputRate = rate(pricing, "outputCost", "completion");
    let cost = 0;
    let cacheFallback = false;
    if (promptTokens) cost += (promptTokens / 1000) * inputRate;
    if (completionTokens) cost += (completionTokens / 1000) * outputRate;
    if (cacheReadTokens) {
      const cached = optionalRate(pricing, "cacheReadCost", "cached_prompt");
      if (cached == null) cacheFallback = true;
      cost += (cacheReadTokens / 1000) * (cached ?? inputRate);
    }
    if (cacheWriteTokens) {
      const write = optionalRate(pricing, "cacheWriteCost", "cache_write");
      if (write == null) cacheFallback = true;
      cost += (cacheWriteTokens / 1000) * (write ?? inputRate);
    }

    if (cost <= 0) return undefined;
    return { cost, cacheFallback };
  }

  public matchPricingModelKey(model: string): string | undefined {
    return this.lookupPrice(model)?.[0];
  }

  private lookupPrice(model: string): [string, PricingRates] | undefined {
    const normalized = String(model || '').trim();
    if (!normalized) {
      return undefined;
    }

    if (this.table[normalized]) {
      return [normalized, this.table[normalized]];
    }

    const lower = normalized.toLowerCase();
    for (const [key, value] of Object.entries(this.table)) {
      if (key.toLowerCase() === lower) {
        return [key, value];
      }
    }

    const keys = Object.keys(this.table).sort((a, b) => b.length - a.length);
    const suffixHits: Array<[string, PricingRates]> = [];
    for (const [key, value] of Object.entries(this.table)) {
      if (modelTail(key).toLowerCase() === lower) {
        suffixHits.push([key, value]);
      }
    }
    if (suffixHits.length) {
      suffixHits.sort((a, b) => a[0].length - b[0].length);
      return suffixHits[0];
    }
    for (const key of keys) {
      if (lower.startsWith(key.toLowerCase())) {
        return [key, this.table[key]];
      }
    }

    return undefined;
  }

  public snapshot(): { table: PricingTable; source: string; generatedAt: string } {
    return {
      table: this.table,
      source: this.source,
      generatedAt: this.generatedAt
    };
  }
}

// Process-level singleton using globalThis
const GLOBAL_RESOLVER_KEY = Symbol.for('__TRACCIA_COST_RESOLVER__');

export function getResolver(): CostResolver {
  const globalAny = globalThis as any;
  if (!globalAny[GLOBAL_RESOLVER_KEY]) {
    globalAny[GLOBAL_RESOLVER_KEY] = new CostResolver(DEFAULT_PRICING);
  }
  return globalAny[GLOBAL_RESOLVER_KEY];
}

export function setResolver(resolver: CostResolver): void {
  const globalAny = globalThis as any;
  globalAny[GLOBAL_RESOLVER_KEY] = resolver;
}

function rate(pricing: PricingRates, primary: keyof PricingRates, alias: keyof PricingRates): number {
  const value = pricing[primary] ?? pricing[alias];
  return typeof value === "number" ? value : 0;
}

function optionalRate(pricing: PricingRates, primary: keyof PricingRates, alias: keyof PricingRates): number | undefined {
  const value = pricing[primary] ?? pricing[alias];
  return typeof value === "number" ? value : undefined;
}

function modelTail(key: string): string {
  const tail = key.replace(/\\/g, "/").split("/").pop() ?? key;
  const dot = tail.indexOf(".");
  if (dot > 0) {
    const head = tail.slice(0, dot);
    const rest = tail.slice(dot + 1);
    if (/^[a-z][a-z0-9-]*$/i.test(head) && rest.includes("-")) return rest;
  }
  return tail;
}
