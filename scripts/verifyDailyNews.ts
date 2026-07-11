import { verifyDailyNewsReport } from "../src/lib/reportAcceptance";
import { generateDailyNewsReport } from "./newsService";

async function main() {
  const { report, metrics } = await generateDailyNewsReport({
    limitPerSection: 3,
    maxSources: 10,
    repairSummariesWithModel: false,
    useFirecrawlKeyless: false,
  });
  const result = verifyDailyNewsReport(report, metrics);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
