import { parseResponse } from "hono/client";
import { useMemo } from "react";
import { apiClient } from "../lib/apiClient";
import { useProgressMutations } from "../lib/context/progressMutations";
import type { PersistedPhase } from "../lib/phase";
import { highestPhase } from "../lib/phase";

export function useTopicSession(taskId: string) {
  const mutations = useProgressMutations();

  return useMemo(
    () => ({
      saveSession: async (phase: PersistedPhase) => {
        const result = await parseResponse(
          apiClient.api["topic-sessions"][":taskId"].$put({
            param: { taskId },
            json: { phase },
          }),
        );
        const syntheticState = { phases: { [phase.name]: phase } } as Parameters<typeof highestPhase>[0];
        const top = highestPhase(syntheticState);
        if (top) {
          const partIdx = "partIdx" in phase ? phase.partIdx : undefined;
          mutations.setActiveSession({ taskId, name: top, partIdx });
        }
        return result;
      },
      deleteSession: async () => {
        const result = await parseResponse(apiClient.api["topic-sessions"][":taskId"].$delete({ param: { taskId } }));
        mutations.clearActiveSession(taskId);
        return result;
      },
    }),
    [taskId, mutations],
  );
}
