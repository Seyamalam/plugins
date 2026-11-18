import type { Values } from "./api";
import type { Connection } from "./connection";
import type { ProviderInfo } from "./models";
import { INITIAL_SESSION, NOT_ANSWERING, nextSession, retryDelay, screenFor, type Screen, type SessionEvent, type SessionState } from "./sessionState.ts";
import { applyShell, type ShellThread } from "./shellState.ts";
import type { Transport } from "./transport";

export const ATTEMPT_MS = 15_000;
export const HEARTBEAT_MS = 10_000;
export const PROJECT_ID = "ardia-workspace";

export type SessionSnapshot = {
  readonly state: SessionState;
  readonly screen: Screen;
  readonly healthy: boolean;
  readonly connection: Connection | null;
  readonly api: Transport["api"] | null;
  readonly openUrl: ((url: string) => void) | null;
  readonly values: Values;
  readonly workspaceRoot: string | null;
  readonly providers: ProviderInfo[] | null;
  readonly projectId: string | null;
  readonly threads: ShellThread[];
  readonly shellLoaded: boolean;
};

export type CoreTimers = {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
};

const realTimers: CoreTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "The assistant couldn't start.");

export class SessionCore {
  private readonly openTransport: () => Promise<Transport>;
  private readonly timers: CoreTimers;
  private readonly attemptMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<() => void>();
  private state: SessionState = INITIAL_SESSION;
  private healthy = true;
  private transport: Transport | null = null;
  private opening: Promise<Transport> | null = null;
  private stopShell: (() => void) | null = null;
  private stopHealth: (() => void) | null = null;
  private beat: unknown = null;
  private retryTimer: unknown = null;
  private shellMap = new Map<string, ShellThread>();
  private values: Values = {};
  private workspaceRoot: string | null = null;
  private providers: ProviderInfo[] | null = null;
  private projectId: string | null = null;
  private threads: ShellThread[] = [];
  private shellLoaded = false;
  private snapshot: SessionSnapshot;

  constructor(deps: { openTransport: () => Promise<Transport>; timers?: CoreTimers; attemptMs?: number }) {
    this.openTransport = deps.openTransport;
    this.timers = deps.timers ?? realTimers;
    this.attemptMs = deps.attemptMs ?? ATTEMPT_MS;
    this.snapshot = this.makeSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  start() {
    this.dispatch({ type: "start" });
  }

  retry() {
    this.dispatch({ type: "attempt" });
  }

  stop() {
    this.dispatch({ type: "stop" });
  }

  setValues(values: Values) {
    this.values = values;
    this.changed();
  }

  private phase() {
    return this.state.phase;
  }

  async ready(): Promise<void> {
    if (this.phase() === "ready") return;
    this.dispatch({ type: "attempt" });
    while (this.phase() === "starting" || this.phase() === "idle") await new Promise<void>((resolve) => this.waiters.add(resolve));
    if (this.phase() !== "ready") throw new Error(this.state.error ?? "The assistant is still getting ready. Try again in a moment.");
  }

  async ensureProject(): Promise<string> {
    if (this.projectId) return this.projectId;
    await this.ready();
    if (this.projectId) return this.projectId;
    const transport = this.transport;
    const workspaceRoot = this.workspaceRoot;
    if (!transport || !workspaceRoot) throw new Error("The assistant is still getting ready. Try again in a moment.");
    await transport.connection.call((c) =>
      c["projects.mutate"]({ type: "project.create", commandId: crypto.randomUUID(), projectId: PROJECT_ID, title: "Ardia", workspaceRoot, createWorkspaceRootIfMissing: true } as never),
    );
    this.projectId = PROJECT_ID;
    this.changed();
    return PROJECT_ID;
  }

  async refreshProviders(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    await transport.connection.call((c) => c["server.refreshProviders"]({} as never)).catch(() => undefined);
    await this.loadProviders(transport);
  }

  private dispatch(event: SessionEvent) {
    const before = this.state;
    const after = nextSession(before, event);
    if (after === before) return;
    this.state = after;
    if (before.phase === "retrying" && after.phase !== "retrying") this.clearRetry();
    if (after.phase === "starting" && before.phase !== "starting") void this.attempt(after.epoch);
    if (after.phase === "retrying" && before.phase !== "retrying") this.retryTimer = this.timers.setTimeout(() => this.dispatch({ type: "attempt" }), retryDelay(after.failures));
    if (after.phase === "stopped") this.teardown();
    if (after.phase !== "starting" && after.phase !== "idle") for (const wake of [...this.waiters]) (this.waiters.delete(wake), wake());
    this.changed();
  }

  private async attempt(epoch: number) {
    let timer: unknown = null;
    try {
      await Promise.race([
        this.setUp(),
        new Promise<never>((_, reject) => (timer = this.timers.setTimeout(() => reject(new Error("The assistant didn't answer in time.")), this.attemptMs))),
      ]);
      this.dispatch({ type: "succeeded", epoch });
    } catch (error) {
      this.dispatch({ type: "failed", epoch, error: messageOf(error) });
    } finally {
      if (timer !== null) this.timers.clearTimeout(timer);
    }
  }

  private async setUp() {
    const transport = await this.connect();
    const info = await transport.api.info();
    if (this.phase() === "stopped") return;
    this.values = info.values;
    this.workspaceRoot = info.workspaceRoot;
    await this.loadProviders(transport);
    if (this.phase() === "stopped" || this.stopShell) return;
    this.shellMap = new Map();
    let firstItem: (() => void) | null = null;
    let firstFailure: ((error: Error) => void) | null = null;
    const loaded = new Promise<void>((resolve, reject) => ((firstItem = resolve), (firstFailure = reject)));
    let stop: (() => void) | null = null;
    stop = transport.connection.subscribe(
      (c) => c["orchestration.subscribeShell"]({} as never),
      (item: unknown) => {
        const next = applyShell(this.shellMap, item as Record<string, unknown>);
        this.shellMap = next.threads;
        if (next.projectId) this.projectId ??= next.projectId;
        this.threads = [...next.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
        this.shellLoaded = true;
        firstItem?.();
        this.changed();
      },
      (error) => {
        firstFailure?.(new Error(error ? messageOf(error) : "The assistant's runtime stopped answering."));
        if (this.stopShell === stop) this.stopShell = null;
        this.dispatch({ type: "lost", error: error ? messageOf(error) : "The assistant's runtime stopped answering." });
      },
    );
    this.stopShell = stop;
    await loaded;
  }

  private async connect(): Promise<Transport> {
    if (this.transport) return this.transport;
    this.opening ??= this.openTransport().finally(() => (this.opening = null));
    const opened = await this.opening;
    if (this.phase() === "stopped") {
      opened.connection.close();
      throw new Error("The page closed.");
    }
    if (this.transport) return this.transport;
    this.transport = opened;
    const onHealth = (healthy: boolean) => {
      if (healthy === this.healthy) return;
      this.healthy = healthy;
      this.dispatch(healthy ? { type: "attempt" } : { type: "lost", error: NOT_ANSWERING });
      this.changed();
    };
    if (opened.onHealth) this.stopHealth = opened.onHealth(onHealth);
    else this.beat = this.timers.setInterval(() => void opened.healthy().then(onHealth), HEARTBEAT_MS);
    this.changed();
    return opened;
  }

  private async loadProviders(transport: Transport) {
    const config = (await transport.connection.call((c) => c["server.getConfig"]({} as never))) as unknown as { providers: ProviderInfo[] };
    this.providers = [...config.providers];
    this.changed();
  }

  private clearRetry() {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private teardown() {
    this.clearRetry();
    if (this.beat !== null) this.timers.clearInterval(this.beat);
    this.beat = null;
    this.stopHealth?.();
    this.stopShell?.();
    this.stopShell = null;
    this.transport?.connection.close();
    this.transport = null;
  }

  private makeSnapshot(): SessionSnapshot {
    return {
      state: this.state,
      screen: screenFor(this.state, this.healthy),
      healthy: this.healthy,
      connection: this.transport?.connection ?? null,
      api: this.transport?.api ?? null,
      openUrl: this.transport?.openUrl ?? null,
      values: this.values,
      workspaceRoot: this.workspaceRoot,
      providers: this.providers,
      projectId: this.projectId,
      threads: this.threads,
      shellLoaded: this.shellLoaded,
    };
  }

  private changed() {
    this.snapshot = this.makeSnapshot();
    for (const listener of [...this.listeners]) listener();
  }
}
