import { test } from "node:test";
import assert from "node:assert/strict";
import { Asks } from "../runtime/src/asks.ts";
import { handleApi } from "../runtime/src/ardiaApi.ts";
import * as Tools from "../runtime/src/browserTools.ts";
import { TurnLedger, providerTurnKey } from "../runtime/src/turnLedger.ts";

const CHAT = "0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f";
const OTHER = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function world() {
  const chat = { type: "tab", id: "chat", url: `ardia://ai/${CHAT}`, title: "chat", group: "g1", split: null, active: true };
  const doc = { type: "tab", id: "doc", url: "https://docs.example/x", title: "doc", group: "g1", split: null };
  const bank = { type: "tab", id: "bank", url: "https://bank.example/home", title: "bank", group: null, split: null };
  const calls = [];
  let replyLater = null;
  const host = {
    calls,
    holdNextBrowse: () => new Promise((ready) => (replyLater = ready)),
    workspace: async () => ({ windows: [{ id: "w1", spaces: [{ profile: "p", tabs: [{ type: "group", id: "g1", items: [chat, doc] }, bank] }] }] }),
    browse: (tabId, argv) => {
      calls.push(["browse", tabId, ...argv]);
      const reply = { ok: true, text: `content of ${tabId}` };
      if (!replyLater) return Promise.resolve(reply);
      const ready = replyLater;
      replyLater = null;
      return new Promise((resolve) => ready(() => resolve(reply)));
    },
    banner: async (id, text) => void calls.push(["banner", id, text]),
    groupWithChat: async () => ({ group: "g1" }),
    splitToGroup: async () => ({ group: "g1" }),
  };
  return host;
}

function runtime({ turnStop = async () => {} } = {}) {
  const ledger = new TurnLedger();
  const host = world();
  const stopped = new Set();
  const memory = {
    opened: () => new Map(),
    tagged: () => new Set(),
    noteOpened: () => {},
    hasReadPages: () => true,
    noteReadPages: () => {},
    tag: () => {},
    startOnce: () => false,
    stopped: (c) => stopped.has(c),
    noteStopped: (c) => void stopped.add(c),
    noteSent: (c) => void stopped.delete(c),
  };
  const asks = new Asks(1000);
  asks.onChange((chatId) => {
    for (const a of asks.pending(chatId)) setTimeout(() => asks.answer(chatId, a.id, "allow"), 0);
  });
  const deps = {
    host,
    state: { memory, asks },
    ledger,
    turns: { stop: turnStop },
    values: () => ({}),
    appVersion: "",
    workspaceRoot: "",
    count: () => {},
  };
  const toolCall = (threadId, body) => {
    const found = ledger.lookup(threadId);
    if (!found.ok) return Promise.reject(Object.assign(new Error(found.refusal), { code: found.refusal }));
    const ctx = { host, asks, memory, grants: { list: () => [], save: () => {} }, turn: found.turn };
    return body(ctx);
  };
  const api = (path, body = {}) => handleApi("POST", path, new URLSearchParams(), { chat: CHAT, ...body }, deps);
  return { ledger, host, deps, toolCall, api };
}

const clicks = (host) => host.calls.filter((c) => c[0] === "browse" && c[2] === "click").map((c) => c[3]);
const refusedAs = (code) => (e) => e.code === code;

test("Stop, the runtime can't be read, a new send: a late tool call from the old turn is refused", async () => {
  const r = runtime({ turnStop: async () => Promise.reject(new Error("projection read failed")) });
  r.ledger.launched(CHAT, "run-1", providerTurnKey("pt", 1));
  await r.api("/ardia/stop");
  const sent = await r.api("/ardia/send", { tabs: [] });
  assert.equal(sent.status, 200, "a send never waits on, or trusts, a read of the old turn");
  await assert.rejects(r.toolCall(CHAT, (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"));
  assert.deepEqual(clicks(r.host), []);
});

test("Stop while the old turn is still stopping long after any deadline, a new send: the old turn's late call is refused", async () => {
  const r = runtime();
  r.ledger.launched(CHAT, "run-1", providerTurnKey("pt", 1));
  await r.api("/ardia/stop");
  await new Promise((done) => setTimeout(done, 20));
  await r.api("/ardia/send", { tabs: [] });
  await assert.rejects(r.toolCall(CHAT, (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"));
  r.ledger.launched(CHAT, "run-1", providerTurnKey("pt", 1));
  assert.deepEqual(r.ledger.lookup(CHAT), { ok: false, refusal: "stopped" }, "relaunching the stopped run never revives it");
  assert.deepEqual(clicks(r.host), []);
});

test("A second Stop during a send: the turn launched after it works, the old turn's tools never do", async () => {
  const r = runtime();
  r.ledger.launched(CHAT, "run-1", providerTurnKey("pt", 1));
  let oldTurn;
  await r.toolCall(CHAT, (ctx) => ((oldTurn = ctx), Tools.click(ctx, CHAT, "doc", "@e1")));
  await r.api("/ardia/stop");
  const sending = r.api("/ardia/send", { tabs: [] });
  await r.api("/ardia/stop");
  await sending;
  r.ledger.ended(providerTurnKey("pt", 1));
  r.ledger.launched(CHAT, "run-2", providerTurnKey("pt", 2));
  await r.toolCall(CHAT, (ctx) => Tools.click(ctx, CHAT, "doc", "@e2"));
  await assert.rejects(Tools.click(oldTurn, CHAT, "doc", "@e3"), refusedAs("stopped"));
  assert.deepEqual(clicks(r.host), ["@e1", "@e2"]);
});

test("A tool call with no turn, an ended turn or another chat's turn is refused", async () => {
  const r = runtime();
  await assert.rejects(r.toolCall(CHAT, (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("unknown"));
  r.ledger.launched(OTHER, "run-9", providerTurnKey("other", 1));
  await assert.rejects(r.toolCall(CHAT, (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("unknown"));
  r.ledger.launched(CHAT, "run-1", providerTurnKey("pt", 1));
  let ended;
  await r.toolCall(CHAT, (ctx) => ((ended = ctx), Tools.listTabs(ctx, CHAT)));
  r.ledger.ended(providerTurnKey("pt", 1));
  await assert.rejects(r.toolCall(CHAT, (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("ended"));
  await assert.rejects(Tools.click(ended, CHAT, "doc", "@e1"), refusedAs("ended"), "a call that outlives its turn can't act either");
  assert.equal(r.ledger.lookup(OTHER).ok, true, "Stop in one chat leaves another chat's turn alone");
  assert.deepEqual(clicks(r.host), []);
});

test("A host reply that arrives after Stop is dropped and nothing follows it", async () => {
  const r = runtime();
  r.ledger.launched(CHAT, "run-1", providerTurnKey("pt", 1));
  const held = r.host.holdNextBrowse();
  const typing = r.toolCall(CHAT, (ctx) => Tools.type(ctx, CHAT, "doc", "@e2", "hello", true));
  const release = await held;
  await r.api("/ardia/stop");
  release();
  await assert.rejects(typing, refusedAs("stopped"));
  const actions = r.host.calls.filter((c) => c[0] === "browse").map((c) => c[2]);
  assert.deepEqual(actions, ["fill"], "the fill's late reply never leads to Enter");
});

test("Stop while a tool waits on its ask: the call reports stopped, and an Always given at that moment grants nothing", async () => {
  const r = runtime();
  r.ledger.launched(CHAT, "run-1", providerTurnKey("pt", 1));
  const saved = [];
  const reading = r.toolCall(CHAT, (ctx) => Tools.readTab({ ...ctx, asks: lateAsks(r, () => "always"), grants: { list: () => [], save: (g) => saved.push(g) } }, CHAT, "bank"));
  await assert.rejects(reading, refusedAs("stopped"));
  assert.deepEqual(saved, [], "no grant is saved after Stop");
});

function lateAsks(r, answer) {
  return { ask: async () => (await r.api("/ardia/stop"), answer()), pending: () => [], answer: () => false, cancelChat: () => {}, onChange: () => () => {} };
}
