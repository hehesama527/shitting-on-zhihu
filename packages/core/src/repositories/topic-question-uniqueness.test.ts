import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClaimedQuestionExclusionClause,
  buildCrossAccountQuestionDuplicateReason,
  buildQuestionLockName,
  pickQuestionOwner
} from "./topic-question-uniqueness.js";

test("older open candidate owns the question, later copies are skipped", () => {
  const owner = pickQuestionOwner(
    [
      { id: 20, status: "new", validityStatus: "valid", accountId: 2 },
      { id: 11, status: "new", validityStatus: "valid", accountId: 1 }
    ],
    20
  );
  assert.equal(owner?.id, 11);
  assert.equal(owner?.accountId, 1);
});

test("accepted or processing owner beats any later open candidate", () => {
  const owner = pickQuestionOwner(
    [
      { id: 8, status: "new", validityStatus: "valid", accountId: 1 },
      { id: 30, status: "accepted", validityStatus: "valid", accountId: 3 }
    ],
    8
  );
  assert.equal(owner?.id, 30);
  assert.equal(owner?.status, "accepted");
});

test("an older unused copy still owns the question even if it is not marked valid", () => {
  const owner = pickQuestionOwner(
    [
      { id: 9, status: "new", validityStatus: "invalid", accountId: 2 },
      { id: 3, status: "new", validityStatus: "invalid", accountId: 1 }
    ],
    9
  );
  assert.equal(owner?.id, 3);
});

test("a candidate does not lose to a newer unused copy of the same question", () => {
  const owner = pickQuestionOwner(
    [
      { id: 4, status: "new", validityStatus: "valid", accountId: 1 },
      { id: 9, status: "new", validityStatus: "valid", accountId: 2 }
    ],
    4
  );
  assert.equal(owner, null);
});

test("exclusion SQL blocks claimed statuses and older open copies", () => {
  const clause = buildClaimedQuestionExclusionClause("tc");
  assert.match(clause, /claimed\.status IN \('processing', 'accepted', 'published'\)/);
  assert.match(clause, /claimed\.id < tc\.id/);
  assert.equal(buildQuestionLockName("abc".repeat(30)).length <= 64, true);
  assert.equal(
    buildCrossAccountQuestionDuplicateReason("API 怎么买更便宜", 3),
    "该问题已被账号 3 占用，全站只回答一次：API 怎么买更便宜"
  );
});
