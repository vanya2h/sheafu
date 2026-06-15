import { useMemo } from "react";
import { useModelStore } from "rxfy-react";
import { useLocale } from "../../app/hooks/useLocale";
import { listCurriculums } from "../data/curriculum";
import type { CurriculumDef } from "../data/types";
import { parseCurriculumDef } from "../data/types";
import { CustomCurriculumModel } from "../lib/models/curriculum";

export function useAllCurriculums(): CurriculumDef[] {
  const locale = useLocale();
  const store = useModelStore(CustomCurriculumModel);

  return useMemo(() => {
    const custom: CurriculumDef[] = [];
    for (const [, entity] of store.valueEntries()) {
      const parsed = parseCurriculumDef(entity);
      if (parsed !== null) {
        custom.push(parsed);
      }
    }
    return [...listCurriculums(locale), ...custom];
  }, [locale, store]);
}
