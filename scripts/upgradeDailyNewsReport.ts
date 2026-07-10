import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultPreferences } from "../src/config/preferences.js";
import { buildDailyReport } from "../src/lib/newsPipeline.js";
import type { DailyNewsReport, RankedNewsItem } from "../src/types";
import { expandLegacyItems, passesPublishGate } from "./reportStore.js";

const outputPath = resolve(process.cwd(), "public/daily-news.json");
const temporaryOutputPath = `${outputPath}.tmp`;

async function main() {
  const stored = JSON.parse(await readFile(outputPath, "utf8")) as Partial<DailyNewsReport>;
  if (!Array.isArray(stored.items) || stored.items.length === 0) throw new Error("The stored report has no items to upgrade.");
  const timestamp = Date.parse(stored.generatedAt ?? "");
  const report = buildDailyReport(
    expandLegacyItems(stored.items as RankedNewsItem[]),
    defaultPreferences,
    Number.isFinite(timestamp) ? new Date(timestamp) : new Date(),
  );
  if (!passesPublishGate(report)) throw new Error("Upgraded report did not pass the publish gate.");

  await writeFile(temporaryOutputPath, JSON.stringify(report, null, 2), "utf8");
  await rename(temporaryOutputPath, outputPath);
  console.log(
    `Upgraded ${report.items.length} events: ${report.topStories.length} must-know, ${report.importantStories.length} important, ${report.watchlist.length} watchlist.`,
  );
}

main().catch((error) => {
  void rm(temporaryOutputPath, { force: true });
  console.error(error);
  process.exitCode = 1;
});
