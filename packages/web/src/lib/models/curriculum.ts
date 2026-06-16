import { createModel } from "rxfy";

import { CurriculumDefSchema } from "~/data/types";

export const CustomCurriculumModel = createModel(CurriculumDefSchema, {
  getKey: (e) => e.id,
  name: "CustomCurriculum",
});
