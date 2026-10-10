// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { settleNonEditorial } from "./content.ts";
import { boundedTrialEnabled, trialArticleAllowed, trialStoryAllowed } from "../dailynews/trial.ts";
import { enqueue, QUEUES, work } from "./queue.ts";

export async function registerEventJobs(boss: PgBoss) {
  // Serial on purpose: two reports of the same new fact must not both create it.
  await work(boss, QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async ({ articleId, signalOnly, force }) => {
    if (!await trialArticleAllowed(articleId)) return { verdict: "outside-trial" };
    // A discussion post comes here straight from collection: record it first (settleNonEditorial).
    const batchEditorial = !boundedTrialEnabled() && !force;
    if (signalOnly && !force && !(await settleNonEditorial(articleId, batchEditorial)).group) return { verdict: "skipped" };
    const result = await groupArticle(articleId, { signalOnly, force, batchEditorial });
    if (result.storyId && !result.verdict.startsWith("signal")) {
      await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
    }
    return result;
  });
  await work(boss, QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, async ({ storyId, afterCorrection }) => {
    if (!await trialStoryAllowed(storyId)) return { updated: false, reason: "outside-trial" };
    return composeStoryDigest(storyId, { afterCorrection });
  });
}
