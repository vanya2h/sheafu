import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { StoreProvider } from "rxfy-react";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StoreProvider ssr>
        <HydratedRouter />
      </StoreProvider>
    </StrictMode>,
  );
});
