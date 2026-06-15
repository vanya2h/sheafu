import type { ClientResponse } from "hono/client";
import { DetailedError, parseResponse } from "hono/client";
import type { IAtom } from "rxfy";
import { createAtom } from "rxfy";
import { rateLimitEvent$ } from "./atoms";

export type LlmStreamState =
  | { status: "streaming"; text: string }
  | { status: "complete"; text: string }
  | { status: "error"; error: unknown };

export type LlmStream = {
  state$: IAtom<LlmStreamState>;
  retry: () => void;
};

export type LlmFetcher = (signal: AbortSignal) => Promise<ClientResponse<unknown>>;

export async function* readSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          yield JSON.parse(line.slice(6)) as string;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createLlmStream(fetcher: LlmFetcher): LlmStream {
  return createLlmAtom(fetcher);
}

function createLlmAtom(fetcher: LlmFetcher): LlmStream {
  const state$ = createAtom<LlmStreamState>({ status: "streaming", text: "" });
  let controller: AbortController | null = null;

  async function execute() {
    controller?.abort();
    controller = new AbortController();
    state$.set({ status: "streaming", text: "" });
    try {
      const res = await fetcher(controller.signal);
      if (!res.ok) await parseResponse(res);
      if (!res.body) throw new Error("No response body");
      let acc = "";
      for await (const delta of readSSEStream(res.body)) {
        if (controller.signal.aborted) return;
        acc += delta;
        state$.set({ status: "streaming", text: acc });
      }
      if (!controller.signal.aborted) state$.set({ status: "complete", text: acc });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DetailedError && (err as { statusCode?: unknown }).statusCode === 429) {
        const data = (err as DetailedError).detail?.data;
        rateLimitEvent$.set({
          resetAt: typeof data?.resetAt === "string" ? new Date(data.resetAt) : new Date(Date.now() + 3_600_000),
          used: typeof data?.used === "number" ? data.used : 0,
          limit: typeof data?.limit === "number" ? data.limit : 10_000,
        });
      }
      state$.set({ status: "error", error: err });
    }
  }

  void execute();
  return { state$, retry: () => void execute() };
}

const cache = new Map<string, LlmStream>();

export function getLlmStream(key: string, fetcher: LlmFetcher): LlmStream {
  const cached = cache.get(key);
  if (cached) return cached;
  const stream = createLlmAtom(fetcher);
  cache.set(key, stream);
  return stream;
}
