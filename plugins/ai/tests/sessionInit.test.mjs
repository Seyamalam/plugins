import { test } from "node:test";
import assert from "node:assert/strict";
import { initMachine } from "../page/src/sessionInit.ts";

test("after every first retry fails, the error is kept, and the next attempt (a project creation, a reconnect) sets everything up again", async () => {
  let up = false;
  let setUps = 0;
  const states = [];
  const m = initMachine(
    async () => {
      setUps++;
      if (!up) throw new Error("The runtime isn't answering.");
    },
    (s) => states.push(s),
    async () => {},
    [1, 2],
  );
  await m.start();
  assert.equal(setUps, 3, "the first try and both retries");
  assert.deepEqual(m.state(), { phase: "failed", error: "The runtime isn't answering.", attempts: 3 });
  up = true;
  await m.retry();
  assert.equal(setUps, 4, "the whole setup runs again");
  assert.equal(m.state().phase, "ready");
  assert.equal(m.state().error, null);
  await m.retry();
  assert.equal(setUps, 4, "a ready session doesn't set up again");
});

test("nothing but a successful setup clears a failure", async () => {
  const m = initMachine(async () => Promise.reject(new Error("no providers")), () => {}, async () => {}, []);
  await m.start();
  assert.equal(m.state().phase, "failed");
  assert.equal(m.state().error, "no providers", "a healthy link or a quiet wait leaves the failure in place");
});

test("a dropped subscription invalidates a ready session and sets it up again", async () => {
  let setUps = 0;
  const m = initMachine(async () => void setUps++, () => {}, async () => {}, [1]);
  await m.start();
  assert.equal(m.state().phase, "ready");
  await m.invalidate(new Error("stream ended"));
  assert.equal(setUps, 2);
  assert.equal(m.state().phase, "ready");
});

test("retries while one is running share it", async () => {
  let release;
  let setUps = 0;
  const m = initMachine(() => (setUps++, new Promise((r) => (release = r))), () => {}, async () => {}, []);
  const a = m.start();
  const b = m.retry();
  release();
  await Promise.all([a, b]);
  assert.equal(setUps, 1);
});

test("a stopped machine reports nothing more", async () => {
  const states = [];
  let release;
  const m = initMachine(() => new Promise((r) => (release = r)), (s) => states.push(s.phase), async () => {}, []);
  const run = m.start();
  m.stop();
  release();
  await run;
  assert.deepEqual(states, ["starting"]);
});
