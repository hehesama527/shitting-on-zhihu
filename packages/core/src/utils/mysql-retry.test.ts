import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableLockError, withDeadlockRetry } from "./mysql-retry.js";

test("isRetryableLockError matches mysql deadlock and lock wait timeout", () => {
  assert.equal(isRetryableLockError({ code: "ER_LOCK_DEADLOCK", errno: 1213, message: "boom" }), true);
  assert.equal(isRetryableLockError({ code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205 }), true);
  assert.equal(
    isRetryableLockError(new Error("Deadlock found when trying to get lock; try restarting transaction")),
    true
  );
  assert.equal(isRetryableLockError(new Error("syntax error")), false);
});

test("withDeadlockRetry retries deadlock then succeeds", async () => {
  let calls = 0;
  const value = await withDeadlockRetry(async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error("Deadlock found when trying to get lock; try restarting transaction");
      (error as Error & { code: string }).code = "ER_LOCK_DEADLOCK";
      throw error;
    }
    return "ok";
  }, { attempts: 4, baseDelayMs: 10 });

  assert.equal(value, "ok");
  assert.equal(calls, 3);
});
