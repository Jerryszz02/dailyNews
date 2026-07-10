import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateDailyNewsReport } from "./newsService";
import { passesPublishGate, readBundledReport } from "./reportStore";

const outputPath = resolve(process.cwd(), "public/daily-news.json");
const temporaryOutputPath = `${outputPath}.tmp`;

async function main() {
  const { report, mode, rawItemCount } = await generateDailyNewsReport();
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
