export type RunToken = { readonly id: number; readonly signal: AbortSignal };

type Run = { id: number; controller: AbortController };

export class Runs {
  private readonly current = new Map<string, Run>();
  private nextId = 1;

  token(chatId: string): RunToken {
    let run = this.current.get(chatId);
    if (!run) {
      run = { id: this.nextId++, controller: new AbortController() };
      this.current.set(chatId, run);
    }
    return { id: run.id, signal: run.controller.signal };
  }

  stopped(chatId: string): boolean {
    return this.current.get(chatId)?.controller.signal.aborted ?? false;
  }

  stop(chatId: string): void {
    this.token(chatId);
    this.current.get(chatId)!.controller.abort(new Error("stopped"));
  }

  begin(chatId: string): RunToken {
    if (this.stopped(chatId)) this.current.delete(chatId);
    return this.token(chatId);
  }
}
