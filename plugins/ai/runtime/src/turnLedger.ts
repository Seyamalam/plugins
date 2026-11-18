export type TurnToken = { readonly runId: string; readonly signal: AbortSignal };

export type TurnRefusal = "unknown" | "ended" | "stopped";

export type TurnLookup = { ok: true; turn: TurnToken } | { ok: false; refusal: TurnRefusal };

type Turn = { threadId: string; runId: string; controller: AbortController; ended: boolean; stopped: boolean };

export const providerTurnKey = (providerThreadId: string, runOrdinal: number) => `${providerThreadId}#${runOrdinal}`;

export class TurnLedger {
  private readonly turns = new Map<string, Turn>();
  private readonly onProvider = new Map<string, string>();
  private readonly current = new Map<string, string>();

  launched(threadId: string, runId: string, providerTurn: string): void {
    const known = this.turns.get(runId);
    const keep = known && known.threadId === threadId && (known.stopped || !known.ended);
    if (!keep) this.turns.set(runId, { threadId, runId, controller: new AbortController(), ended: false, stopped: false });
    this.onProvider.set(providerTurn, runId);
    this.current.set(threadId, runId);
    this.forgetEnded(threadId, runId);
  }

  ended(providerTurn: string): void {
    const runId = this.onProvider.get(providerTurn);
    if (runId === undefined) return;
    this.onProvider.delete(providerTurn);
    const turn = this.turns.get(runId);
    if (!turn || turn.ended) return;
    turn.ended = true;
    turn.controller.abort(new Error("ended"));
  }

  stop(threadId: string): number {
    let stopped = 0;
    for (const turn of this.turns.values()) {
      if (turn.threadId !== threadId || turn.stopped) continue;
      turn.stopped = true;
      if (!turn.ended) stopped++;
      turn.controller.abort(new Error("stopped"));
    }
    return stopped;
  }

  lookup(threadId: string): TurnLookup {
    const runId = this.current.get(threadId);
    const turn = runId === undefined ? undefined : this.turns.get(runId);
    if (!turn) return { ok: false, refusal: "unknown" };
    if (turn.stopped) return { ok: false, refusal: "stopped" };
    if (turn.ended) return { ok: false, refusal: "ended" };
    return { ok: true, turn: { runId: turn.runId, signal: turn.controller.signal } };
  }

  private forgetEnded(threadId: string, keep: string): void {
    for (const [runId, turn] of this.turns) {
      if (turn.threadId === threadId && runId !== keep && turn.ended) this.turns.delete(runId);
    }
  }
}

export const turnLedger = new TurnLedger();
