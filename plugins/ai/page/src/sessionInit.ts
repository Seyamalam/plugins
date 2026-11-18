export type InitPhase = "starting" | "ready" | "failed";
export type InitState = { phase: InitPhase; error: string | null; attempts: number };

export const INIT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

export type InitMachine = {
  start(): Promise<void>;
  retry(): Promise<void>;
  invalidate(error: unknown): Promise<void>;
  stop(): void;
  state(): InitState;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function initMachine(
  setUp: () => Promise<void>,
  onState: (state: InitState) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delays: readonly number[] = INIT_DELAYS_MS,
): InitMachine {
  let state: InitState = { phase: "starting", error: null, attempts: 0 };
  let running: Promise<void> | null = null;
  let stopped = false;
  const set = (next: InitState) => {
    state = next;
    if (!stopped) onState(next);
  };
  const attempt = async () => {
    set({ phase: "starting", error: state.error, attempts: state.attempts });
    try {
      await setUp();
      if (!stopped) set({ phase: "ready", error: null, attempts: state.attempts + 1 });
      return true;
    } catch (error) {
      if (!stopped) set({ phase: "failed", error: message(error), attempts: state.attempts + 1 });
      return false;
    }
  };
  const run = (rounds: readonly number[]) =>
    (running ??= (async () => {
      if (await attempt()) return;
      for (const delay of rounds) {
        if (stopped) return;
        await wait(delay);
        if (stopped || (await attempt())) return;
      }
    })().finally(() => {
      running = null;
    }));
  return {
    start: () => run(delays),
    retry: () => (state.phase === "ready" ? Promise.resolve() : run([])),
    invalidate: (error) => {
      if (stopped) return Promise.resolve();
      if (state.phase === "ready") set({ phase: "failed", error: message(error), attempts: state.attempts });
      return run(delays);
    },
    stop: () => {
      stopped = true;
    },
    state: () => state,
  };
}
