import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateDailyNewsReport } from "./newsService";

const outputPath = resolve(process.cwd(), "public/daily-news.json");

async function main() {
  const { report, mode, rawItemCount } = await generateDailyNewsReport();

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`Generated ${report.items.length} ranked items from ${report.sourceCount} sources using ${mode} data (${rawItemCount} raw items).`);
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
