import { parseResponse } from "hono/client";
import { useMemo } from "react";
import { useModelStore } from "rxfy-react";
import { useRootData } from "../../app/hooks/useRootData";
import { apiClient } from "../lib/apiClient";
import { useProgressMutations } from "../lib/context/progressMutations";
import { ActiveSessionModel, TaskCompletionModel } from "../lib/models/progress";
import type { PersistedPhase } from "../lib/phase";

export type ActivityEntry = {
  date: string;
  taskIds: string[];
  minutes: number;
};

export type ActiveSession = {
  name: PersistedPhase["name"];
  partIdx?: number;
};

export type Progress = {
  completedTaskIds: Record<string, string>;
  activity: Record<string, ActivityEntry>;
  startedAt: string;
  activeSessions: Record<string, ActiveSession>;
};

export function useProgress() {
  const data = useRootData();
  const mutations = useProgressMutations();
  const completionStore = useModelStore(TaskCompletionModel);
  const sessionStore = useModelStore(ActiveSessionModel);

  const completedTaskIds = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [, entity] of completionStore.valueEntries()) {
      map[entity.taskId] = entity.completedAt;
    }
    return map;
  }, [completionStore]);

  const activeSessions = useMemo(() => {
    const map: Record<string, ActiveSession> = {};
    for (const [, entity] of sessionStore.valueEntries()) {
      map[entity.taskId] = { name: entity.name as ActiveSession["name"], partIdx: entity.partIdx };
    }
    return map;
  }, [sessionStore]);

  async function toggleTask(taskId: string) {
    mutations.toggleTask(taskId);
    await parseResponse(apiClient.api.progress.tasks[":taskId"].toggle.$post({ param: { taskId } }));
  }

  return {
    completedTaskIds,
    activity: (data?.progress?.activity ?? {}) as Record<string, ActivityEntry>,
    startedAt: data?.progress?.startedAt ?? new Date().toISOString(),
    activeSessions,
    toggleTask,
  };
}
