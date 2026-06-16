import { createModel } from "rxfy";
import { z } from "zod";
import { PHASE_ORDER } from "../phase";

export const TaskCompletionModel = createModel(z.object({ taskId: z.string(), completedAt: z.string() }), {
  getKey: (e) => e.taskId,
  name: "TaskCompletion",
});

export const DailyActivityModel = createModel(
  z.object({ date: z.string(), taskIds: z.array(z.string()), minutes: z.number() }),
  { getKey: (e) => e.date, name: "DailyActivity" },
);

export const ActiveSessionModel = createModel(
  z.object({ taskId: z.string(), name: z.enum(PHASE_ORDER), partIdx: z.number().optional() }),
  { getKey: (e) => e.taskId, name: "ActiveSession" },
);

export type TaskCompletion = z.infer<typeof TaskCompletionModel.schema>;
export type DailyActivity = z.infer<typeof DailyActivityModel.schema>;
export type ActiveSession = z.infer<typeof ActiveSessionModel.schema>;
