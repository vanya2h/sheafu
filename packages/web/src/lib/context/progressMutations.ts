import { createContext, use } from "react";
import type { ProgressMutations } from "../state/progress";

export const ProgressMutationsContext = createContext<ProgressMutations | null>(null);

export function useProgressMutations(): ProgressMutations {
  const ctx = use(ProgressMutationsContext);
  if (!ctx) throw new Error("useProgressMutations must be used inside ProgressMutationsContext");
  return ctx;
}
