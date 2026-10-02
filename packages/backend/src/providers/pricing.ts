// Estimates from an operator-pinned DeepSeek price window, never a provider invoice.
// DeepSeek's peak rules exclude Chinese public holidays; this module does not infer holidays.
// Source checked 2026-10-03: https://api-docs.deepseek.com/quick_start/pricing/

export interface ObservedTokens {
  promptTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  completionTokens: number | null;
}

export interface PriceEstimate {
  amount: number;
  currency: "USD";
  basis: "estimated";
  snapshot: {
    id: "deepseek-v4.1-flash-2026-10-03";
    source: "https://api-docs.deepseek.com/quick_start/pricing/";
    requestedModel: "deepseek-flash";
    responseModel: string;
    band: "peak" | "off_peak";
    validFrom: string;
    validUntil: string;
    usdPerMillion: { cacheHitInput: number; cacheMissInput: number; output: number };
  };
  pricedAt: Date;
}

function tokens(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export function observedTokens(usage: Record<string, unknown> | null | undefined): ObservedTokens {
  return {
    promptTokens: tokens(usage?.prompt_tokens),
    cacheHitTokens: tokens(usage?.prompt_cache_hit_tokens),
    cacheMissTokens: tokens(usage?.prompt_cache_miss_tokens),
    completionTokens: tokens(usage?.completion_tokens),
  };
}

/** Missing or inconsistent provider counters, response model, band, or window means unknown cost. */
export function estimateDeepSeekFlash(
  requestedModel: string,
  responseModel: string | null,
  usage: Record<string, unknown> | null | undefined,
  at: Date,
  env: NodeJS.ProcessEnv = process.env,
): PriceEstimate | null {
  if (requestedModel !== "deepseek-flash" || !responseModel ||
    !["deepseek-flash", "deepseek-v4.1-flash"].includes(responseModel.toLowerCase())) return null;
  const band = env.DAILYNEWS_DEEPSEEK_PRICE_BAND;
  if (band !== "peak" && band !== "off_peak") return null;
  const validFrom = env.DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM;
  const validUntil = env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL;
  if (!validFrom || !validUntil || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(validFrom) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(validUntil)) return null;
  const fromMs = Date.parse(validFrom);
  const untilMs = Date.parse(validUntil);
  if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs) || fromMs >= untilMs || at.getTime() < fromMs || at.getTime() >= untilMs) return null;
  const observed = observedTokens(usage);
  const { promptTokens, cacheHitTokens, cacheMissTokens, completionTokens } = observed;
  if (promptTokens === null || cacheHitTokens === null || cacheMissTokens === null || completionTokens === null ||
    promptTokens !== cacheHitTokens + cacheMissTokens) return null;
  const usdPerMillion = band === "off_peak"
    ? { cacheHitInput: 0.003, cacheMissInput: 0.15, output: 0.6 }
    : { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 };
  // Rates are exact thousandths of a dollar per million tokens. Sum integer milli-USD
  // first, so adding floating point rate products cannot inflate a tiny estimate.
  const milliUsdPerMillion = band === "off_peak"
    ? { cacheHitInput: 3, cacheMissInput: 150, output: 600 }
    : { cacheHitInput: 6, cacheMissInput: 300, output: 1200 };
  const milliUsdTokens = cacheHitTokens * milliUsdPerMillion.cacheHitInput +
    cacheMissTokens * milliUsdPerMillion.cacheMissInput + completionTokens * milliUsdPerMillion.output;
  if (!Number.isSafeInteger(milliUsdTokens)) return null;
  return {
    amount: milliUsdTokens / 1_000_000_000,
    currency: "USD", basis: "estimated", pricedAt: at,
    snapshot: {
      id: "deepseek-v4.1-flash-2026-10-03", source: "https://api-docs.deepseek.com/quick_start/pricing/",
      requestedModel: "deepseek-flash", responseModel, band, validFrom, validUntil, usdPerMillion,
    },
  };
}
