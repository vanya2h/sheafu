import { array, defineState } from "rxfy";
import { z } from "zod";
import type { ActiveSession, DailyActivity, TaskCompletion } from "../models/progress";
import { ActiveSessionModel, DailyActivityModel, TaskCompletionModel } from "../models/progress";

type ProgressShape = {
  completions: TaskCompletion[];
  activity: DailyActivity[];
  activeSessions: ActiveSession[];
};

export const progressMutations = {
  toggleTask: (prev: ProgressShape, taskId: string): ProgressShape => ({
    ...prev,
    completions: prev.completions.some((c) => c.taskId === taskId)
      ? prev.completions.filter((c) => c.taskId !== taskId)
      : [...prev.completions, { taskId, completedAt: new Date().toISOString() }],
  }),

  setActiveSession: (prev: ProgressShape, session: ActiveSession): ProgressShape => ({
    ...prev,
    activeSessions: [...prev.activeSessions.filter((s) => s.taskId !== session.taskId), session],
  }),

  clearActiveSession: (prev: ProgressShape, taskId: string): ProgressShape => ({
    ...prev,
    activeSessions: prev.activeSessions.filter((s) => s.taskId !== taskId),
  }),
};

export const progressState = defineState({
  key: "progress",
  params: z.object({}),
  model: {
    completions: array(TaskCompletionModel),
    activity: array(DailyActivityModel),
    activeSessions: array(ActiveSessionModel),
  },
  mutations: progressMutations,
});

// Bound mutation signatures (rxfy strips the `prev` arg; these are what callers receive)
export type ProgressMutations = {
  toggleTask: (taskId: string) => void;
  setActiveSession: (session: ActiveSession) => void;
  clearActiveSession: (taskId: string) => void;
};
