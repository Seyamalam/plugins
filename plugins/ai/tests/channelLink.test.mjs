import { test } from "node:test";
import assert from "node:assert/strict";
import { Assembler, ChannelLink, PAGE_TO_HELPER_LIMIT, SENDS_PER_SECOND, split } from "../page/src/channelLink.ts";

function fakeBridge() {
  const sent = [];
  let listener = null;
  return {
    sent,
    deliver: (data) => listener({ data }),
    bridge: { send: (v) => sent.push(v), addEventListener: (_t, l) => (listener = l), removeEventListener: () => (listener = null) },
  };
}

test("a call goes out as one frame and settles with its own result, by id", async () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge);
  const a = link.call("server.getConfig", {});
  const b = link.call("orchestration.getThreadProjection", { threadId: "t1" });
  assert.deepEqual(f.sent.map((x) => [x.t, x.method]), [["call", "server.getConfig"], ["call", "orchestration.getThreadProjection"]]);
  f.deliver({ t: "result", id: f.sent[1].id, ok: false, error: "no such thread" });
  f.deliver({ t: "result", id: f.sent[0].id, ok: true, value: { providers: [] } });
  assert.deepEqual(await a, { providers: [] });
  await assert.rejects(b, /no such thread/);
});

test("a stream delivers batched items in order, ends once, and a cancel stops it", () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge);
  const items = [];
  let ended = 0;
  const stop = link.stream("orchestration.subscribeThread", { threadId: "t1" }, (i) => items.push(i), () => ended++);
  const id = f.sent[0].id;
  f.deliver({ t: "items", id, items: [1, 2] });
  f.deliver({ t: "items", id, items: [3] });
  assert.deepEqual(items, [1, 2, 3]);
  stop();
  assert.deepEqual(f.sent.at(-1), { t: "cancel", id });
  f.deliver({ t: "items", id, items: [4] });
  f.deliver({ t: "end", id });
  assert.deepEqual(items, [1, 2, 3]);
  assert.equal(ended, 0, "a cancelled stream doesn't report an end");
});

test("frames past the size limit go in parts and come back whole", () => {
  const big = { t: "call", id: 7, method: "orchestration.dispatchCommand", payload: { text: "x".repeat(150_000) } };
  let n = 0;
  const parts = split(big, PAGE_TO_HELPER_LIMIT, () => `p${++n}`);
  assert.ok(parts.length > 2 && parts.every((p) => p.t === "part" && JSON.stringify(p).length < 64 * 1024));
  const a = new Assembler();
  const shuffled = [parts[1], parts[0], ...parts.slice(2)];
  const out = shuffled.map((p) => a.take(p)).filter(Boolean);
  assert.deepEqual(out, [big]);
});

test("a large answer from the helper is reassembled before it reaches the caller", async () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge);
  const p = link.call("orchestration.getThreadProjection", {});
  const value = { text: "y".repeat(500_000) };
  for (const part of split({ t: "result", id: f.sent[0].id, ok: true, value }, 240_000, () => "h1")) f.deliver(part);
  assert.deepEqual(await p, value);
});

test("sends past the per-second budget wait instead of being dropped by the host", () => {
  const f = fakeBridge();
  let now = 1_000;
  const link = new ChannelLink(f.bridge, () => now);
  for (let i = 0; i < SENDS_PER_SECOND + 20; i++) link.open(`https://example.com/${i}`);
  assert.equal(f.sent.length, SENDS_PER_SECOND, "the first burst stops at the budget");
  link.close();
});
