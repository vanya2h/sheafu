import { useStateData } from "rxfy-react";

import { useApiClient } from "~/lib/apiClient";
import { curriculaState } from "~/lib/state/curricula";

export function useCurriculaData() {
  const apiClient = useApiClient();

  return useStateData(curriculaState, () => apiClient.api.curriculums.published.$get().then((r) => r.json()), {});
}
