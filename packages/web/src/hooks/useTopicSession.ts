import { parseResponse } from "hono/client";
import { useMemo } from "react";
import { useProgressData } from "./useProgressData";

import { useApiClient } from "~/lib/apiClient";
import type { PersistedPhase } from "~/lib/phase";

export function useTopicSession(taskId: string) {
  const { mutations } = useProgressData();
  const apiClient = useApiClient();

  return useMemo(
    () => ({
      saveSession: async (phase: PersistedPhase) => {
        const result = await parseResponse(
          apiClient.api["topic-sessions"][":taskId"].$put({
            param: { taskId },
            json: { phase },
          }),
        );
        const partIdx = "partIdx" in phase ? phase.partIdx : undefined;
        mutations.setActiveSession({ taskId, name: phase.name, partIdx });
        return result;
      },
      deleteSession: async () => {
        const result = await parseResponse(apiClient.api["topic-sessions"][":taskId"].$delete({ param: { taskId } }));
        mutations.clearActiveSession(taskId);
        return result;
      },
    }),
    [apiClient, taskId, mutations],
  );
}
