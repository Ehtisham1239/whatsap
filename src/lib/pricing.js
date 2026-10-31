import { isWindowOpen } from "./window.js";

export const CATEGORIES = Object.freeze(["marketing", "utility", "authentication", "service"]);

/** Credits charged per delivered-attempt message. Override with PRICE_<CATEGORY> env vars. */
export const DEFAULT_PRICES = Object.freeze({ marketing: 10, utility: 4, authentication: 4, service: 0 });

export function loadPrices(env = process.env) {
  const prices = { ...DEFAULT_PRICES };
  for (const c of CATEGORIES) {
    const raw = env[`PRICE_${c.toUpperCase()}`];
    if (raw === undefined || raw === "") continue;
    if (!/^\d+$/.test(raw)) throw new Error(`PRICE_${c.toUpperCase()} must be a non-negative integer`);
    prices[c] = Number(raw);
  }
  return Object.freeze(prices);
}

/**
 * Decides the billing category and credits for an outbound message.
 * - Free-form messages are only possible inside the service window: "service", free.
 * - Utility templates sent inside an open service window are free (Meta per-message pricing).
 * - Everything inside an open CTWA free-entry-point window is free.
 */
export function priceOutbound({ mode, templateCategory, window, now = new Date(), prices = DEFAULT_PRICES }) {
  const open = isWindowOpen(window, now);
  if (mode === "custom") return { category: "service", credits: prices.service };
  if (mode !== "template") throw new TypeError(`cannot price mode ${mode}`);
  if (!CATEGORIES.includes(templateCategory) || templateCategory === "service") {
    throw new TypeError(`invalid template category ${templateCategory}`);
  }
  if (open && window.source === "ctwa") return { category: templateCategory, credits: 0 };
  if (open && templateCategory === "utility") return { category: "utility", credits: 0 };
  return { category: templateCategory, credits: prices[templateCategory] };
}
