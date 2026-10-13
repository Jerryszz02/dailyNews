import { gzipSync, gunzipSync } from "node:zlib";

interface StoredResponse {
  response: unknown;
  response_compressed?: Uint8Array | null;
}

/** Turn on only after all receipt readers have upgraded; decoding is always enabled. */
export const receiptCompressionEnabled = () => process.env.RECEIPT_COMPRESSION_ENABLED === "true";

export function compressReceiptJson(json: string): Buffer | null {
  const raw = Buffer.from(json);
  if (raw.length < 1024 || raw.length > 64 * 1024 * 1024) return null;
  const compressed = gzipSync(raw);
  return compressed.length + 32 < raw.length ? compressed : null;
}

/** Small/incompressible JSON stays readable in place; large responses have one lossless copy. */
export function encodeReceiptResponse(response: unknown): { response: unknown; compressed: Buffer | null } {
  const normalized = response ?? null;
  const json = JSON.stringify(normalized);
  if (json === undefined) throw new Error("Receipt response must be JSON serializable");
  const compressed = compressReceiptJson(json);
  return compressed
    ? { response: null, compressed }
    : { response: normalized, compressed: null };
}

/** A damaged saved answer must fail closed: it must never trigger another paid request. */
export function decodeReceiptResponse(row: StoredResponse): unknown {
  if (!row.response_compressed) return row.response;
  try {
    if (row.response !== null && row.response !== undefined) throw new Error("ambiguous receipt storage");
    return JSON.parse(gunzipSync(row.response_compressed, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
  } catch (cause) {
    throw new Error("Saved receipt response cannot be decoded; preserve the receipt for repair", { cause });
  }
}
