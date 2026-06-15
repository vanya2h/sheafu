import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
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
  return isbot(request.headers.get("user-agent") ?? "")
    ? handleBuffered(request, responseStatusCode, responseHeaders, routerContext)
    : handleBuffered(request, responseStatusCode, responseHeaders, routerContext);
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
          const snapshot = dehydrate(registry);
          const chunks: Buffer[] = [];
          const intermediate = new PassThrough();

          intermediate.on("data", (chunk: Buffer) => chunks.push(chunk));
          intermediate.on("end", () => {
            const body = new PassThrough();
            responseHeaders.set("Content-Type", "text/html");
            resolve(
              new Response(createReadableStreamFromReadable(body), {
                headers: responseHeaders,
                status: responseStatusCode,
              }),
            );
            for (const chunk of chunks) body.write(chunk);
            body.write(hydrationScript(snapshot));
            body.end();
          });

          pipe(intermediate);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    setTimeout(abort, ABORT_DELAY);
  });
}
