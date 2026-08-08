import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DailyNewsReport } from "../src/types";
import { generateDailyNewsReport } from "./newsService";
import { passesPublishGate, readBundledReport } from "./reportStore";

const outputPath = resolve(process.cwd(), "public/daily-news.json");
const temporaryOutputPath = `${outputPath}.tmp`;

async function main() {
  const { report, mode, rawItemCount, usedLiveData } = await generateDailyNewsReport();
  const publicationError = generatedReportPublicationError(report, usedLiveData, readBundledReport());
  if (publicationError) throw new Error(publicationError);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(temporaryOutputPath, JSON.stringify(report, null, 2), "utf8");
  await rename(temporaryOutputPath, outputPath);

  console.log(`Generated ${report.items.length} ranked items from ${report.sourceCount} sources using ${mode} data (${rawItemCount} raw items).`);
  console.log(`Wrote ${outputPath}`);
}

export function generatedReportPublicationError(
  report: DailyNewsReport,
  usedLiveData: boolean,
  previousReport: DailyNewsReport | null,
): string | null {
  if (!usedLiveData) return "Live collection returned no publishable items; kept the existing report.";
  if (!passesPublishGate(report, previousReport)) return "Generated report did not pass the publish gate.";
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    void rm(temporaryOutputPath, { force: true });
    console.error(error);
    process.exitCode = 1;
  });
}
