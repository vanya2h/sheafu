import { createModel } from "rxfy";
import { z } from "zod";

export const CustomCurriculumModel = createModel(z.object({ id: z.string() }).passthrough(), {
  getKey: (e) => e.id,
  name: "CustomCurriculum",
});
