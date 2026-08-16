import { describe, expect, it } from "vitest";
import { createPublicSourceLookup, isPublicSourceAddress, resolvePublicSourceAddress } from "./sourceNetworkPolicy";

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

  it("returns the pinned address shape requested by the runtime connector", async () => {
    const lookup = createPublicSourceLookup(async () => [{ address: "1.1.1.1", family: 4 }]);

    const addresses = await new Promise((resolve, reject) => {
      lookup("news.example.com", { all: true }, (error, result) => error ? reject(error) : resolve(result));
    });

    expect(addresses).toEqual([{ address: "1.1.1.1", family: 4 }]);
  });
});
