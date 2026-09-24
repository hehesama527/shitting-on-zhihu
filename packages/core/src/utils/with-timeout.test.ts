import assert from "node:assert/strict";
import { test } from "node:test";
import { withTimeoutReject } from "./with-timeout.js";

test("withTimeoutReject resolves before timeout and does not run onTimeout", async () => {
  let timedOut = false;
  const value = await withTimeoutReject(
    Promise.resolve("ok"),
    50,
    "timed out",
    async () => {
      timedOut = true;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(value, "ok");
  assert.equal(timedOut, false);
});

test("withTimeoutReject aborts via onTimeout then rejects", async () => {
  let timedOut = false;
  await assert.rejects(
    withTimeoutReject(
      new Promise(() => undefined),
      20,
      "发布步骤超时",
      async () => {
        timedOut = true;
      }
    ),
    /发布步骤超时/
  );
  assert.equal(timedOut, true);
});
