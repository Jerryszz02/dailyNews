import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluatePublishedContentFreshness } from "../src/lib/contentFreshness";
import { generateDailyNewsReport } from "./newsService";
import { passesPublishGate, readBundledReport } from "./reportStore";

const outputPath = resolve(process.cwd(), "public/daily-news.json");
const temporaryOutputPath = `${outputPath}.tmp`;

async function main() {
  const { report, mode, rawItemCount, usedLiveData } = await generateDailyNewsReport();
  if (!usedLiveData) throw new Error("Live collection returned no publishable items; kept the existing report.");
  if (!evaluatePublishedContentFreshness(report.items, new Date(report.generatedAt)).publishable) {
    throw new Error("Live collection contains no news published within 120 minutes; kept the existing report.");
  }
  if (!passesPublishGate(report, readBundledReport())) throw new Error("Generated report did not pass the publish gate.");

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(temporaryOutputPath, JSON.stringify(report, null, 2), "utf8");
  await rename(temporaryOutputPath, outputPath);

  console.log(`Generated ${report.items.length} ranked items from ${report.sourceCount} sources using ${mode} data (${rawItemCount} raw items).`);
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  void rm(temporaryOutputPath, { force: true });
  console.error(error);
  process.exitCode = 1;
});
