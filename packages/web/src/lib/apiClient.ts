import { hc } from "hono/client";
import { createContext, useContext } from "react";
import type { AppType } from "../server/app";

export type ApiClient = ReturnType<typeof hc<AppType>>;

export const browserApiClient: ApiClient = hc<AppType>(typeof window !== "undefined" ? window.location.origin : "");

const ApiClientContext = createContext<ApiClient>(browserApiClient);

export const ApiClientProvider = ApiClientContext.Provider;

export function useApiClient(): ApiClient {
  return useContext(ApiClientContext);
}
