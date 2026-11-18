// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";
import type { TurnControl } from "./ardiaApi.ts";

export function turnControl(self: { call(method: string, payload: unknown): Promise<unknown> }): TurnControl {
  return {
    stop: async (chatId) => {
      await self.call("orchestration.dispatchCommand", { type: "thread.stop", commandId: Crypto.randomUUID(), threadId: chatId, reason: "Stopped in Ardia" });
    },
  };
}
