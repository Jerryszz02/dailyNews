import { describe, expect, it } from "vitest";
import { sourceLabel } from "./App";
import { newsSources } from "./config/sources";

describe("sourceLabel", () => {
  it("returns a Chinese display label for every enabled source", () => {
    for (const source of newsSources.filter((item) => item.enabled)) {
      expect(sourceLabel(source.name)).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
