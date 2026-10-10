import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { collectionDomain } from "../packages/backend/src/lib/collection-domain.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

test("域名归一化统一直接链接与 Jina 包装链接", () => {
  assert.equal(collectionDomain("https://www.Example.org/news"), "example.org");
  assert.equal(
    collectionDomain("https://r.jina.ai/https://www.Example.org/news"),
    "example.org",
  );
});

test("同域两篇仍在处理时，其他域可以进入全局消费者", async () => {
  const boss = await getBoss();
  const queue = `domain-${tag()}`;
  await boss.createQueue(queue);
  try {
    for (let i = 0; i < 3; i++)
      await boss.send(
        queue,
        { domain: "slow.example", i },
        {
          priority: 10,
          group: { id: collectionDomain("https://slow.example/" + i) },
        },
      );
    await boss.send(
      queue,
      { domain: "fast.example" },
      { group: { id: collectionDomain("https://fast.example/news") } },
    );
    const first = await boss.fetch<{ domain: string }>(queue, {
      batchSize: 4,
      groupConcurrency: 2,
    });
    assert.equal(
      first.filter((job) => job.data.domain === "slow.example").length,
      2,
    );
    assert.equal(
      first.filter((job) => job.data.domain === "fast.example").length,
      1,
    );
    await boss.send(
      queue,
      { domain: "second.example" },
      { group: { id: "second.example" } },
    );
    // Another fetch represents another worker/node while the first two slow jobs remain active.
    const second = await boss.fetch<{ domain: string }>(queue, {
      batchSize: 4,
      groupConcurrency: 2,
    });
    assert.deepEqual(
      second.map((job) => job.data.domain),
      ["second.example"],
    );
    await boss.complete(
      queue,
      first.map((job) => job.id),
    );
    const resumed = await boss.fetch<{ domain: string }>(queue, {
      batchSize: 4,
      groupConcurrency: 2,
    });
    assert.deepEqual(
      resumed.map((job) => job.data.domain),
      ["slow.example"],
    );
    await boss.complete(
      queue,
      [...second, ...resumed].map((job) => job.id),
    );
  } finally {
    await boss.deleteQueue(queue);
  }
});
