import { array, defineState } from "rxfy";
import { z } from "zod";
import { CustomCurriculumModel } from "../models/curriculum";

export const curriculaState = defineState({
  key: "curricula",
  params: z.object({}),
  model: { curricula: array(CustomCurriculumModel) },
});
