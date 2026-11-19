import { Trans, useLingui } from "@lingui/react/macro";
import { parseResponse } from "hono/client";
import { useNavigate } from "react-router";
import type { Task } from "../data/types";
import type { ActiveSession } from "../hooks/useProgress";
import { useProgress } from "../hooks/useProgress";
import { apiClient } from "../lib/apiClient";
import { PHASE_ROUTES } from "../lib/phase";
import { getTopicLinks } from "../lib/routes";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { cn } from "~/lib/utils";

function useSessionLabel(session: ActiveSession): string {
  const { t } = useLingui();
  const part = (session.partIdx ?? 0) + 1;
  switch (session.name) {
    case "assessing":
      return t`Assessing`;
    case "gaps-review":
      return t`Assessment done`;
    case "study":
      return t`Part ${part} · Study`;
    case "hands-on":
      return t`Part ${part} · Practice`;
    case "feedback":
      return t`Part ${part} · Feedback`;
    case "write-up":
      return t`Part ${part} · Write-up`;
    default: {
      const _exhaustive: never = session.name;
      return _exhaustive;
    }
  }
}

function ActiveSessionLabel({ session }: { session: ActiveSession }) {
  const label = useSessionLabel(session);
  return <span className="ml-2 text-xs text-amber-500 dark:text-amber-400 font-medium">{label}</span>;
}

export function TaskRow({ task, curriculumId }: { task: Task; curriculumId: string }) {
  const { completedTaskIds, activeSessions } = useProgress();
  const navigate = useNavigate();
  const checked = !!completedTaskIds[task.id];
  const activeSession = activeSessions[task.id];

  return (
    <div className="group flex items-center gap-3 py-2 px-3 sm:px-4 rounded-md transition-colors hover:bg-foreground/10">
      <label className="flex items-center gap-3 flex-1 min-w-0">
        <Checkbox checked={checked} readOnly className="pointer-events-none shrink-0" />
        <span
          className={cn(
            "text-sm leading-snug line-clamp-2",
            checked ? "line-through text-foreground/40" : "text-foreground",
          )}
        >
          {task.title}
          {activeSession && <ActiveSessionLabel session={activeSession} />}
        </span>
      </label>

      {!checked && (
        <div
          className={cn(
            "shrink-0 flex gap-1 transition-opacity",
            !activeSession && "lg:opacity-0 lg:group-hover:opacity-100",
          )}
        >
          {activeSession && (
            <Button
              size="xs"
              variant="secondary"
              className="hidden sm:inline-flex"
              onClick={() => {
                void parseResponse(apiClient.api["topic-sessions"][":taskId"].$delete({ param: { taskId: task.id } }));
                navigate(getTopicLinks(curriculumId, task.id).choice);
              }}
            >
              <Trans>Start over</Trans>
            </Button>
          )}
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              const links = getTopicLinks(curriculumId, task.id);
              navigate(activeSession ? `${links.index}/${PHASE_ROUTES[activeSession.name]}` : links.choice);
            }}
          >
            {activeSession ? <Trans>Continue</Trans> : <Trans>Start</Trans>}
          </Button>
        </div>
      )}
      {task.estMinutes && (
        <span className="hidden sm:inline shrink-0 text-xs text-muted-foreground">
          ~{task.estMinutes >= 60 ? `${Math.round(task.estMinutes / 60)}h` : `${task.estMinutes}m`}
        </span>
      )}
    </div>
  );
}
