import type { NewsStore } from "./newsStore.js";
import { InMemoryNewsStore } from "./inMemoryNewsStore.js";
import { loadLocalEnv } from "./newsService.js";
import { readBundledReport } from "./reportStore.js";
import { createSupabaseNewsStore } from "./supabaseNewsStore.js";

let defaultStore: NewsStore | null | undefined;

export function getDefaultNewsStore(): NewsStore | null {
  if (defaultStore !== undefined) return defaultStore;
  loadLocalEnv();

  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (url && secretKey) {
    defaultStore = createSupabaseNewsStore(url, secretKey);
    return defaultStore;
  }

  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    defaultStore = null;
    return defaultStore;
  }

  defaultStore = new InMemoryNewsStore(readBundledReport());
  return defaultStore;
}

export function resetDefaultNewsStoreForTests(): void {
  defaultStore = undefined;
}

export function hasCompleteSupabaseConfiguration(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}
