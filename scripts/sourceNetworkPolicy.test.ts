import { describe, expect, it } from "vitest";
import {
  createPublicSourceLookup,
  isPublicSourceAddress,
  resolvePublicSourceAddress,
  type ResolvedAddress,
} from "./sourceNetworkPolicy";

describe("source network policy", () => {
  it("allows public addresses and rejects local, private, metadata, and documentation ranges", () => {
    expect(isPublicSourceAddress("1.1.1.1")).toBe(true);
    expect(isPublicSourceAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicSourceAddress("127.0.0.1")).toBe(false);
    expect(isPublicSourceAddress("10.0.0.1")).toBe(false);
    expect(isPublicSourceAddress("169.254.169.254")).toBe(false);
    expect(isPublicSourceAddress("::1")).toBe(false);
    expect(isPublicSourceAddress("fc00::1")).toBe(false);
    expect(isPublicSourceAddress("2001:db8::1")).toBe(false);
  });

  it("fails closed when any DNS answer is not public", async () => {
    await expect(resolvePublicSourceAddress("news.example.com", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toThrow("source_address_not_public");
  });

  it("returns every validated pinned address when the runtime connector requests all answers", async () => {
    const lookup = createPublicSourceLookup(async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);

    const addresses = await new Promise((resolve, reject) => {
      lookup("news.example.com", { all: true }, (error, result) => error ? reject(error) : resolve(result));
    });

    expect(addresses).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);
  });

  it("keeps the first validated pinned address for single-answer lookups", async () => {
    const lookup = createPublicSourceLookup(async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);

    const result = await new Promise<{ address: string | ResolvedAddress[]; family?: number }>((resolve, reject) => {
      lookup("news.example.com", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });

    expect(result).toEqual({ address: "2606:4700:4700::1111", family: 6 });
  });
});
