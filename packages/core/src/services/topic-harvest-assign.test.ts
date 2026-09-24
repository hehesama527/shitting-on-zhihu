import assert from "node:assert/strict";
import { test } from "node:test";
import { planTopicAssignments, shouldHarvestSharedTopicBatch } from "./topic-harvest-assign.js";

test("shared harvest of 10 is split across accounts that still need topics", () => {
  const assignments = planTopicAssignments({
    candidates: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, accountId: 1 })),
    demand: [
      { accountId: 1, neededCount: 2 },
      { accountId: 2, neededCount: 2 },
      { accountId: 3, neededCount: 1 },
      { accountId: 4, neededCount: 1 }
    ]
  });

  const received = new Map<number, number>();
  for (const item of assignments) {
    received.set(item.toAccountId, (received.get(item.toAccountId) ?? 0) + 1);
  }

  assert.equal(received.get(2), 4);
  assert.equal(received.get(3), 2);
  assert.equal(received.get(4), 2);
  assert.equal(received.has(1), false);
  assert.equal(assignments.length, 8);
});

test("existing surplus is given to empty accounts before another harvest", () => {
  const assignments = planTopicAssignments({
    candidates: [
      { id: 11, accountId: 1 },
      { id: 12, accountId: 1 },
      { id: 13, accountId: 1 }
    ],
    demand: [
      { accountId: 1, neededCount: 2 },
      { accountId: 2, neededCount: 2 }
    ]
  });

  assert.deepEqual(assignments, [{ candidateId: 13, fromAccountId: 1, toAccountId: 2 }]);
});

test("shared harvest runs when a demand account is empty or the batch is below 10", () => {
  assert.equal(
    shouldHarvestSharedTopicBatch({
      totalOpenCandidates: 3,
      totalDemand: 6,
      emptyDemandAccounts: 1
    }),
    true
  );
  assert.equal(
    shouldHarvestSharedTopicBatch({
      totalOpenCandidates: 10,
      totalDemand: 6,
      emptyDemandAccounts: 0
    }),
    false
  );
  assert.equal(
    shouldHarvestSharedTopicBatch({
      totalOpenCandidates: 0,
      totalDemand: 0,
      emptyDemandAccounts: 0
    }),
    false
  );
});
