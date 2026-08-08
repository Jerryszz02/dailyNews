import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { newsSources } from "../config/sources";
import {
  defineApprovedSource,
  isAllowedSourceUrl,
  isApprovedSource,
  isCollectibleSource,
  validateSourceAdmission,
} from "./sourceAdmission";

describe("source admission", () => {
  it("uses explicit extensions for runtime imports consumed by Node ESM", () => {
    const sourceModule = readFileSync(new URL("../config/sources.ts", import.meta.url), "utf8");
    const runtimeRelativeImports = [...sourceModule.matchAll(/^import(?!\s+type\b)[\s\S]*?from\s+["'](\.{1,2}\/[^"']+)["'];/gm)]
      .map((match) => match[1]);

    expect(runtimeRelativeImports.length).toBeGreaterThan(0);
    expect(runtimeRelativeImports.every((specifier) => /\.(?:[cm]?js|json)$/.test(specifier))).toBe(true);
  });

  it("migrates every configured source through an explicit reviewed admission boundary", () => {
    expect(validateSourceAdmission(newsSources)).toEqual([]);
    expect(newsSources.every((source) => source.admission === "approved")).toBe(true);
    expect(newsSources.every((source) => source.reviewedAt === "2026-08-03")).toBe(true);
  });

  it("accepts configured hosts and their subdomains but rejects lookalikes", () => {
    const source = defineApprovedSource({
      source_id: "example",
      name: "Example",
      countryOrRegion: "global",
      language: "en-US",
      mediaType: "public",
      defaultWeight: 1,
      credibility: 80,
      sections: [{
        label: "News",
        url: "https://news.example.com/",
        categories: ["international"],
        primaryCategory: "international",
      }],
      mayHavePaywall: false,
      enabled: true,
    });

    expect(isApprovedSource(source)).toBe(true);
    expect(isAllowedSourceUrl(source, "https://news.example.com/story/1")).toBe(true);
    expect(isAllowedSourceUrl(source, "https://live.news.example.com/story/1")).toBe(true);
    expect(isAllowedSourceUrl(source, "https://news.example.com.evil.test/story/1")).toBe(false);
  });

  it("keeps publication admission independent from technical collection enablement", () => {
    const source = { ...newsSources[0], admission: "blocked" as const };
    expect(isApprovedSource(source)).toBe(false);
    expect(isAllowedSourceUrl(source, source.sections[0].url)).toBe(false);
    expect(isApprovedSource({ ...newsSources[0], enabled: false })).toBe(true);
    expect(isCollectibleSource({ ...newsSources[0], enabled: false })).toBe(false);
    expect(isCollectibleSource(newsSources[0])).toBe(true);
  });

  it("scopes shared social hosts to the configured account path", () => {
    const source = newsSources.find((candidate) => candidate.source_id === "x-shams");
    expect(source).toBeDefined();
    expect(source?.allowedPathPrefixes).toEqual(["x.com/shamscharania"]);
    expect(isAllowedSourceUrl(source!, "https://x.com/ShamsCharania/status/123456789")).toBe(true);
    expect(isAllowedSourceUrl(source!, "https://x.com/OpenAI/status/123456789")).toBe(false);
    expect(isAllowedSourceUrl(source!, "https://mobile.x.com/ShamsCharania/status/123456789")).toBe(true);
    expect(isAllowedSourceUrl(source!, "https://mobile.x.com/OpenAI/status/123456789")).toBe(false);
  });
});
