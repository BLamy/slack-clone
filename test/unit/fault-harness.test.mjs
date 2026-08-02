import assert from "node:assert/strict";
import test from "node:test";

import {
  FAULT_HOOKS,
  FROZEN_FAULT_SCHEDULES,
  createFaultScheduler,
  runFaultSchedule,
  runSensitivityChecks,
} from "../../src/ledger/fault-harness.mjs";

test("fault scheduler replays a seeded schedule byte-for-byte", () => {
  const schedule = [
    {
      action: "delay",
      hook: "acknowledge",
      occurrence: 0,
      phase: "before",
      role: "dispatch",
    },
  ];
  const first = createFaultScheduler({ seed: "unit-seed", schedule });
  const second = createFaultScheduler({ seed: "unit-seed", schedule });
  assert.deepEqual(
    first.hit("acknowledge", { phase: "before", role: "dispatch" }),
    second.hit("acknowledge", { phase: "before", role: "dispatch" }),
  );
  assert.deepEqual(first.manifest(), second.manifest());
});

test("every frozen fault schedule reaches every named boundary and converges", async () => {
  for (const schedule of FROZEN_FAULT_SCHEDULES) {
    const result = await runFaultSchedule(schedule, {
      seedCheckpoint:
        schedule.name === "checkpoint-corrupt" ||
        schedule.name === "seeded-combination",
    });
    assert.deepEqual(result.schedule.coveredHooks, [...FAULT_HOOKS]);
    assert.equal(
      result.schedule.matchedScheduleEntries.length,
      result.schedule.schedule.length,
    );
    assert.equal(result.targetDump.length, 3);
    assert.equal(result.receiptDump.length, 3);
    assert.equal(result.finalDigest, result.reader.finalDigest);
    assert.equal(
      result.invalidCausalOrder.rejected.code,
      "REDUCER_ILLEGAL_TRANSITION",
    );
    assert.equal(
      result.invalidCausalOrder.rejected.offset,
      result.invalidCausalOrder.citedOffset,
    );
  }
});

test("sensitivity detectors fail when deduplication, resume, or ordering is removed", async () => {
  const checks = await runSensitivityChecks();
  assert.equal(checks.length, 3);
  assert.ok(checks.every(({ outcome }) => outcome === "rejected"));
});
