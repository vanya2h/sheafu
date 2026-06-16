import { useParams } from "react-router";
import { Pending, useModelStore } from "rxfy-react";
import { getCurriculum } from "../data/curriculum";
import { useCurriculaData } from "../hooks/useCurriculaData";
import { CustomCurriculumModel } from "../lib/models/curriculum";
import { Curriculum } from "./Curriculum";

import { useLocale } from "~app/hooks/useLocale";

export function CurriculumView() {
  const { curriculumId } = useParams<{ curriculumId: string }>();
  const locale = useLocale();
  const { data$: curricula$ } = useCurriculaData();
  const customStore = useModelStore(CustomCurriculumModel);

  if (!curriculumId) return null;

  const builtIn = getCurriculum(curriculumId, locale);
  if (builtIn) return <Curriculum curriculum={builtIn} />;

  return (
    <Pending value$={curricula$}>
      {({ curricula }) => {
        if (!curricula.includes(curriculumId)) return null;
        const custom = customStore.getValue(curriculumId);
        return custom ? <Curriculum curriculum={custom} /> : null;
      }}
    </Pending>
  );
}
