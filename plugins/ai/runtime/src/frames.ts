export type Frame =
  | { t: "call"; p: string; id: number; method: string; payload: unknown }
  | { t: "stream"; p: string; id: number; method: string; payload: unknown }
  | { t: "cancel"; p: string; id: number }
  | { t: "api"; p: string; id: number; method: "GET" | "POST"; path: string; body?: unknown }
  | { t: "open"; p: string; url: string }
  | { t: "ping"; p: string }
  | { t: "pong"; p: string; moved: boolean }
  | { t: "result"; p: string; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "items"; p: string; id: number; items: unknown[] }
  | { t: "end"; p: string; id: number; error?: string }
  | { t: "part"; p: string; id: string; i: number; n: number; s: string };

export const PAGE_TO_HELPER_LIMIT = 60_000;
export const HELPER_TO_PAGE_LIMIT = 240_000;
export const SENDS_PER_SECOND = 80;
export const PING_MS = 3_000;
export const LOST_MS = 10_000;
export const CALL_TIMEOUT_MS = 60_000;
export const INSTANCE = /^[A-Za-z0-9_-]{8,64}$/;

export function split(frame: Frame, limit: number, partId: () => string): Frame[] {
  const text = JSON.stringify(frame);
  if (text.length <= limit) return [frame];
  const size = limit - 200;
  const n = Math.ceil(text.length / size);
  const id = partId();
  return Array.from({ length: n }, (_, i) => ({ t: "part" as const, p: frame.p, id, i, n, s: text.slice(i * size, (i + 1) * size) }));
}

export class Assembler {
  private readonly open = new Map<string, string[]>();

  take(frame: Frame): Frame | null {
    if (frame.t !== "part") return frame;
    if (!Number.isInteger(frame.n) || frame.n < 1 || frame.n > 4096 || !Number.isInteger(frame.i) || frame.i < 0 || frame.i >= frame.n) return null;
    const key = `${frame.p}:${frame.id}`;
    const parts = this.open.get(key) ?? new Array<string>(frame.n);
    parts[frame.i] = frame.s;
    this.open.set(key, parts);
    if (parts.filter((p) => p !== undefined).length < frame.n) return null;
    this.open.delete(key);
    try {
      return JSON.parse(parts.join("")) as Frame;
    } catch {
      return null;
    }
  }

  drop(instance: string) {
    for (const key of this.open.keys()) if (key.startsWith(`${instance}:`)) this.open.delete(key);
  }
}
