export type Frame =
  | { t: "call"; id: number; method: string; payload: unknown }
  | { t: "stream"; id: number; method: string; payload: unknown }
  | { t: "cancel"; id: number }
  | { t: "api"; id: number; method: "GET" | "POST"; path: string; body?: unknown }
  | { t: "open"; url: string }
  | { t: "result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "items"; id: number; items: unknown[] }
  | { t: "end"; id: number; error?: string }
  | { t: "part"; id: string; i: number; n: number; s: string };

export type ArdiaBridge = {
  send(value: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
};

export const PAGE_TO_HELPER_LIMIT = 60_000;
export const HELPER_TO_PAGE_LIMIT = 240_000;
export const SENDS_PER_SECOND = 80;

export function split(frame: Frame, limit: number, partId: () => string): Frame[] {
  const text = JSON.stringify(frame);
  if (text.length <= limit) return [frame];
  const size = limit - 200;
  const n = Math.ceil(text.length / size);
  const id = partId();
  return Array.from({ length: n }, (_, i) => ({ t: "part" as const, id, i, n, s: text.slice(i * size, (i + 1) * size) }));
}

export class Assembler {
  private readonly open = new Map<string, string[]>();

  take(frame: Frame): Frame | null {
    if (frame.t !== "part") return frame;
    const parts = this.open.get(frame.id) ?? new Array<string>(frame.n);
    parts[frame.i] = frame.s;
    this.open.set(frame.id, parts);
    if (parts.filter((p) => p !== undefined).length < frame.n) return null;
    this.open.delete(frame.id);
    return JSON.parse(parts.join("")) as Frame;
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type Stream = { onItem(item: unknown): void; onEnd(error: unknown): void };

export class ChannelLink {
  private nextId = 1;
  private nextPart = 1;
  private readonly calls = new Map<number, Pending>();
  private readonly streams = new Map<number, Stream>();
  private readonly assembler = new Assembler();
  private readonly queue: Frame[] = [];
  private sentAt: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listener = (event: { data: unknown }) => this.receive(event.data);
  private readonly bridge: ArdiaBridge;
  private readonly now: () => number;

  constructor(bridge: ArdiaBridge, now: () => number = () => Date.now()) {
    this.bridge = bridge;
    this.now = now;
    bridge.addEventListener("message", this.listener);
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.bridge.removeEventListener?.("message", this.listener);
    for (const p of this.calls.values()) p.reject(new Error("The assistant's page link closed."));
    for (const s of this.streams.values()) s.onEnd(new Error("closed"));
    this.calls.clear();
    this.streams.clear();
  }

  call(method: string, payload: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.enqueue({ t: "call", id, method, payload });
    });
  }

  api(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.enqueue(body === undefined ? { t: "api", id, method, path } : { t: "api", id, method, path, body });
    });
  }

  stream(method: string, payload: unknown, onItem: (item: unknown) => void, onEnd: (error: unknown) => void): () => void {
    const id = this.nextId++;
    this.streams.set(id, { onItem, onEnd });
    this.enqueue({ t: "stream", id, method, payload });
    return () => {
      if (!this.streams.delete(id)) return;
      this.enqueue({ t: "cancel", id });
    };
  }

  open(url: string) {
    this.enqueue({ t: "open", url });
  }

  private enqueue(frame: Frame) {
    this.queue.push(...split(frame, PAGE_TO_HELPER_LIMIT, () => `p${this.nextPart++}`));
    this.drain();
  }

  private drain() {
    if (this.timer) return;
    while (this.queue.length) {
      const now = this.now();
      this.sentAt = this.sentAt.filter((t) => now - t < 1000);
      if (this.sentAt.length >= SENDS_PER_SECOND) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.drain();
        }, 1000 - (now - this.sentAt[0]!));
        return;
      }
      this.sentAt.push(now);
      this.bridge.send(this.queue.shift());
    }
  }

  private receive(data: unknown) {
    if (!data || typeof data !== "object" || typeof (data as { t?: unknown }).t !== "string") return;
    const frame = this.assembler.take(data as Frame);
    if (!frame) return;
    if (frame.t === "result") {
      const pending = this.calls.get(frame.id);
      if (!pending) return;
      this.calls.delete(frame.id);
      if (frame.ok) pending.resolve(frame.value);
      else pending.reject(new Error(frame.error ?? "The assistant refused that."));
    } else if (frame.t === "items") {
      const stream = this.streams.get(frame.id);
      if (stream) for (const item of frame.items) stream.onItem(item);
    } else if (frame.t === "end") {
      const stream = this.streams.get(frame.id);
      if (!stream) return;
      this.streams.delete(frame.id);
      stream.onEnd(frame.error ? new Error(frame.error) : null);
    }
  }
}

export function ardiaBridge(): ArdiaBridge | null {
  const bridge = (globalThis as { ardia?: Partial<ArdiaBridge> }).ardia;
  return bridge && typeof bridge.send === "function" && typeof bridge.addEventListener === "function" ? (bridge as ArdiaBridge) : null;
}
