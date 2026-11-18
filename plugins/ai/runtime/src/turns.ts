// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as Crypto from "node:crypto";
import type { TurnControl } from "./ardiaApi.ts";

const ACTIVE_RUN = new Set(["queued", "preparing", "starting", "running", "waiting", "awaiting_input", "stopping"]);
const ENDED_POLL_MS = 200;
const ENDED_WAIT_MS = 10_000;

export function activeRunOf(projection: unknown): boolean {
  const runs = (projection as { runs?: Array<{ status?: string }> } | null)?.runs ?? [];
  return runs.some((r) => ACTIVE_RUN.has(String(r.status)));
}

export function turnControl(self: { call(method: string, payload: unknown): Promise<unknown> }, wait = (ms: number) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now()): TurnControl {
  return {
    stop: async (chatId) => {
      await self.call("orchestration.dispatchCommand", { type: "thread.stop", commandId: Crypto.randomUUID(), threadId: chatId, reason: "Stopped in Ardia" });
    },
    ended: async (chatId) => {
      const until = now() + ENDED_WAIT_MS;
      while (now() < until) {
        const projection = await self.call("orchestration.getThreadProjection", { threadId: chatId }).catch(() => null);
        if (!activeRunOf(projection)) return;
        await wait(ENDED_POLL_MS);
      }
    },
  };
}

