import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { hc } from "hono/client";
import { renderToPipeableStream } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { createModelRegistry, dehydrate, hydrationScript } from "rxfy";
import { StoreProvider } from "rxfy-react";

import { type ApiClient, ApiClientProvider } from "~/lib/apiClient";
import { app, type AppType } from "~/server/app";

const ABORT_DELAY = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  return handleBuffered(request, responseStatusCode, responseHeaders, routerContext);
}

function handleBuffered(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  return new Promise<Response>((resolve, reject) => {
    const registry = createModelRegistry();
    const apiClient = createServerApiClient(request);

    const { pipe, abort } = renderToPipeableStream(
      <ApiClientProvider value={apiClient}>
        <StoreProvider registry={registry} ssr>
          <ServerRouter context={routerContext} url={request.url} />
        </StoreProvider>
      </ApiClientProvider>,
      {
        onAllReady() {
          clearTimeout(timeoutId);
          const snapshot = dehydrate(registry);
          const chunks: Buffer[] = [];
          const intermediate = new PassThrough();

          intermediate.on("data", (chunk: Buffer) => chunks.push(chunk));
          intermediate.on("end", () => {
            const body = new PassThrough();
            responseHeaders.set("Content-Type", "text/html");
            for (const chunk of chunks) body.write(chunk);
            body.write(hydrationScript(snapshot));
            body.end();
            resolve(
              new Response(createReadableStreamFromReadable(body), {
                headers: responseHeaders,
                status: responseStatusCode,
              }),
            );
          });

          pipe(intermediate);
        },
        onShellError(error: unknown) {
          clearTimeout(timeoutId);
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    const timeoutId = setTimeout(abort, ABORT_DELAY);
  });
}

function createServerApiClient(request: Request): ApiClient {
  const serverFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(request.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    return app.request(input as Parameters<typeof app.request>[0], { ...init, headers });
  };
  return hc<AppType>("/", { fetch: serverFetch });
}
