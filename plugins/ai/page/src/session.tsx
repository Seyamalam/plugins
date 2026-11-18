import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ArdiaApi, Values } from "./api";
import type { Connection } from "./connection";
import { openTransport, type Transport } from "./transport";
import { initMachine, type InitMachine, type InitState } from "./sessionInit";
import { modelOptions, type ModelOption, type ProviderInfo } from "./models";
import { applyShell, type ShellThread } from "./shellState";

export type { ShellThread };


export type Session = {
  connection: Connection | null;
  api: ArdiaApi | null;
  connected: boolean | null;
  error: string | null;
  providers: ProviderInfo[] | null;
  models: ModelOption[];
  projectId: string | null;
  threads: ShellThread[];
  shellLoaded: boolean;
  values: Values;
  openUrl: ((url: string) => void) | null;
  refreshProviders(): Promise<void>;
  ensureProject(): Promise<string>;
  setValues(values: Values): void;
};

const SessionContext = createContext<Session | null>(null);

export const useSession = () => useContext(SessionContext)!;

const HEARTBEAT_MS = 10_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [api, setApi] = useState<ArdiaApi | null>(null);
  const [init, setInit] = useState<InitState>({ phase: "starting", error: null, attempts: 0 });
  const [healthy, setHealthy] = useState(true);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ShellThread[]>([]);
  const [shellLoaded, setShellLoaded] = useState(false);
  const [values, setValues] = useState<Values>({});
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [openUrl, setOpenUrl] = useState<((url: string) => void) | null>(null);
  const shellMap = useRef(new Map<string, ShellThread>());
  const machine = useRef<InitMachine | null>(null);

  const loadProviders = useCallback(async (conn: Connection, refresh: boolean) => {
    if (refresh) await conn.call((c) => c["server.refreshProviders"]({} as never)).catch(() => undefined);
    const config = (await conn.call((c) => c["server.getConfig"]({} as never))) as unknown as { providers: ProviderInfo[] };
    setProviders([...config.providers]);
  }, []);

  useEffect(() => {
    let transport: Transport | null = null;
    let stopShell: (() => void) | null = null;
    let stopHealth: (() => void) | null = null;
    let beat: ReturnType<typeof setInterval> | null = null;
    const setUp = async () => {
      if (!transport) {
        transport = await openTransport();
        const opened = transport;
        setConnection(opened.connection);
        setApi(opened.api);
        setOpenUrl(() => opened.openUrl);
        const onHealth = (ok: boolean) => {
          setHealthy(ok);
          if (ok) void machine.current?.retry();
        };
        if (opened.onHealth) stopHealth = opened.onHealth(onHealth);
        else beat = setInterval(() => void opened.healthy().then(onHealth), HEARTBEAT_MS);
      }
      const conn = transport.connection;
      const info = await transport.api.info();
      setValues(info.values);
      setWorkspaceRoot(info.workspaceRoot);
      await loadProviders(conn, false);
      if (!stopShell) {
        shellMap.current = new Map();
        stopShell = conn.subscribe(
          (c) => c["orchestration.subscribeShell"]({} as never),
          (item: unknown) => {
            const next = applyShell(shellMap.current, item as Record<string, unknown>);
            shellMap.current = next.threads;
            if (next.projectId) setProjectId((current) => current ?? next.projectId);
            setThreads([...next.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt));
            setShellLoaded(true);
          },
          (error) => {
            stopShell = null;
            void machine.current?.invalidate(error ?? new Error("The assistant's runtime stopped answering."));
          },
        );
      }
    };
    const m = initMachine(setUp, setInit);
    machine.current = m;
    void m.start();
    return () => {
      m.stop();
      if (beat) clearInterval(beat);
      stopHealth?.();
      stopShell?.();
      transport?.connection.close();
    };
  }, [loadProviders]);

  const connected = init.phase === "ready" ? healthy : init.phase === "failed" ? false : null;
  const error = init.phase === "failed" ? init.error : null;

  const value = useMemo<Session>(
    () => ({
      connection,
      api,
      connected,
      error,
      providers,
      models: providers ? modelOptions(providers) : [],
      projectId,
      threads,
      shellLoaded,
      values,
      openUrl,
      refreshProviders: () => (connection ? loadProviders(connection, true) : Promise.resolve()),
      ensureProject: async () => {
        if (projectId) return projectId;
        if (machine.current && machine.current.state().phase !== "ready") await machine.current.retry();
        const ready = machine.current?.state();
        if (ready && ready.phase !== "ready") throw new Error(ready.error ?? "The assistant is still getting ready. Try again in a moment.");
        if (!connection || !workspaceRoot) throw new Error("The assistant is still getting ready. Try again in a moment.");
        const id = "ardia-workspace";
        await connection.call((c) => c["projects.mutate"]({ type: "project.create", commandId: crypto.randomUUID(), projectId: id, title: "Ardia", workspaceRoot, createWorkspaceRootIfMissing: true } as never));
        setProjectId(id);
        return id;
      },
      setValues,
    }),
    [connection, api, connected, error, providers, projectId, threads, shellLoaded, values, workspaceRoot, openUrl, loadProviders],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
