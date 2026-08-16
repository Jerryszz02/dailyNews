import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production acceptance toolchain", () => {
  it("uses only repository-locked runtime packages and the local Vercel CLI", () => {
    const source = readFileSync(new URL("./productionAcceptanceMonitor.ts", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    expect(source).not.toContain("--no-package-lock");
    expect(source).not.toContain('executable("npx")');
    expect(source).toContain('"node_modules", ".bin", "vercel"');
    expect(packageJson.devDependencies).toMatchObject({
      dotenv: expect.stringMatching(/^\d/),
      pg: expect.stringMatching(/^\d/),
      vercel: expect.stringMatching(/^\d/),
    });
  });
});
