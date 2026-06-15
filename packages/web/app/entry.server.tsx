import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { renderToPipeableStream } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { createModelRegistry, dehydrate, hydrationScript } from "rxfy";
import { StoreProvider } from "rxfy-react";

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

    const { pipe, abort } = renderToPipeableStream(
      <StoreProvider registry={registry} ssr>
        <ServerRouter context={routerContext} url={request.url} />
      </StoreProvider>,
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
