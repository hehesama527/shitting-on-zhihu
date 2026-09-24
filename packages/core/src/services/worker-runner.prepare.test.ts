import assert from "node:assert/strict";
import { test } from "node:test";
import { selectAccountScopedPrepareJobs, shouldHarvestAccountPool } from "./worker-runner.js";

function account(id: number, status = "active") {
  return { id, status, cooldownUntil: null as string | null };
}

function job(id: number, accountId: number) {
  return { id, accountId };
}

test("prepare selection keeps one soonest job per account and does not steal other accounts' slots", () => {
  const accountsById = new Map([
    [1, account(1)],
    [2, account(2)],
    [3, account(3)]
  ]);
  const selected = selectAccountScopedPrepareJobs({
    jobs: [job(11, 1), job(12, 1), job(21, 2), job(31, 3)],
    accountsById,
    blockedAccountIds: new Set(),
    inFlightJobIds: new Set(),
    inFlightAccountIds: new Set(),
    limit: 3
  });

  assert.deepEqual(
    selected.map((item) => ({ jobId: item.job.id, accountId: item.job.accountId })),
    [
      { jobId: 11, accountId: 1 },
      { jobId: 21, accountId: 2 },
      { jobId: 31, accountId: 3 }
    ]
  );
});

test("prepare selection skips blocked, in-flight, and login-locked accounts", () => {
  const accountsById = new Map([
    [1, account(1)],
    [2, account(2, "manual_login_required")],
    [3, account(3)],
    [4, account(4)]
  ]);
  const selected = selectAccountScopedPrepareJobs({
    jobs: [job(11, 1), job(21, 2), job(31, 3), job(41, 4)],
    accountsById,
    blockedAccountIds: new Set([4]),
    inFlightJobIds: new Set([11]),
    inFlightAccountIds: new Set([1]),
    limit: 3
  });

  assert.deepEqual(
    selected.map((item) => item.job.id),
    [31]
  );
});

test("prepare selection skips empty-pool accounts so harvest can refill first", () => {
  const accountsById = new Map([
    [1, account(1)],
    [2, account(2)]
  ]);
  const selected = selectAccountScopedPrepareJobs({
    jobs: [job(11, 1), job(21, 2)],
    accountsById,
    blockedAccountIds: new Set(),
    inFlightJobIds: new Set(),
    inFlightAccountIds: new Set(),
    skipAccountIds: new Set([1]),
    limit: 3
  });

  assert.deepEqual(
    selected.map((item) => item.job.id),
    [21]
  );
});

test("empty topic pools always harvest even if prepare is in flight or a slot is imminent", () => {
  assert.equal(
    shouldHarvestAccountPool({
      activeCandidateCount: 0,
      hasInFlightPrepare: true,
      hasImminentJobs: true
    }),
    true
  );
  assert.equal(
    shouldHarvestAccountPool({
      activeCandidateCount: 2,
      hasInFlightPrepare: false,
      hasImminentJobs: false
    }),
    false
  );
});
