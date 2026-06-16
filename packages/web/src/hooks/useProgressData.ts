import { useStateData } from "rxfy-react";

import { useApiClient } from "~/lib/apiClient";
import { progressState } from "~/lib/state/progress";

export function useProgressData() {
  const apiClient = useApiClient();

  return useStateData(progressState, () => apiClient.api.progress.$get().then((r) => r.json()), {});
}
