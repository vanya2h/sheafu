import { parseResponse } from "hono/client";
import { useCallback } from "react";
import { useProgressData } from "./useProgressData";

import { useApiClient } from "~/lib/apiClient";

export function useToggleTask() {
  const { mutations } = useProgressData();
  const apiClient = useApiClient();

  return useCallback(
    async (taskId: string) => {
      mutations.toggleTask(taskId);
      await parseResponse(apiClient.api.progress.tasks[":taskId"].toggle.$post({ param: { taskId } }));
    },
    [apiClient, mutations],
  );
}
