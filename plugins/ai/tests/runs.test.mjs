import { test } from "node:test";
import assert from "node:assert/strict";
import { Runs } from "../runtime/src/runs.ts";
import { activeRunOf, turnControl } from "../runtime/src/turns.ts";

test("a stopped run stays stopped; only a new message makes a new run, and it never revives the old one", () => {
  const runs = new Runs();
  const first = runs.token("c");
  assert.equal(runs.begin("c").id, first.id, "a message during a live run keeps that run");
  runs.stop("c");
  assert.equal(first.signal.aborted, true);
  const second = runs.begin("c");
  assert.notEqual(second.id, first.id);
  assert.equal(second.signal.aborted, false);
  assert.equal(first.signal.aborted, true, "the old token stays aborted");
});

test("Stop stops the model's turn and the next run waits for it to end", async () => {
  const calls = [];
  let polls = 0;
  const self = {
    call: async (method, payload) => {
      calls.push([method, payload.type ?? null]);
      if (method === "orchestration.getThreadProjection") return { runs: [{ status: ++polls < 3 ? "running" : "stopped" }] };
      return null;
    },
  };
  let t = 0;
  const turns = turnControl(self, async (ms) => void (t += ms), () => t);
  await turns.stop("c");
  await turns.ended("c");
  assert.deepEqual(calls[0], ["orchestration.dispatchCommand", "thread.stop"]);
  assert.equal(polls, 3, "it polled until the run was no longer active");
  assert.equal(activeRunOf({ runs: [{ status: "completed" }] }), false);
});
