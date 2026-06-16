import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { parseResponse } from "hono/client";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { Pending, useModelStore } from "rxfy-react";
import type { CurriculumDef } from "../data/types";
import { useProgressData } from "../hooks/useProgressData";
import { useApiClient } from "../lib/apiClient";
import type { ActiveSession } from "../lib/models/progress";
import { ActiveSessionModel } from "../lib/models/progress";
import { PHASE_ORDER } from "../lib/phase";
import { BigColumn } from "./layout/BigColumn";
import { PageBody } from "./layout/PageBody";
import { PageContent } from "./layout/PageContent";
import { Badge } from "./ui/badge";
import { Card } from "./Card";
import { PhaseCard } from "./PhaseCard";
import { ProgramCover } from "./ProgramCover";
import { Ring } from "./Ring";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type CurriculumProps = React.ComponentProps<"main"> & {
  curriculum: CurriculumDef;
};

export function Curriculum({ curriculum, className, ...restProps }: CurriculumProps) {
  const { data$ } = useProgressData();

  return (
    <PageBody className={cn("relative", className)} {...restProps}>
      {curriculum.cover && (
        <div className="absolute inset-0">
          <ProgramCover shape="wave" preset={curriculum.cover} />
        </div>
      )}
      <PageContent className="relative">
        <BigColumn>
          <Pending value$={data$}>
            {({ completions, activeSessions }) => {
              const completedSet = new Set(completions);
              const activeSet = new Set(activeSessions);
              let completedTasks = 0;
              let totalTasks = 0;
              let remainingMinutes = 0;
              for (const phase of curriculum.phases) {
                for (const task of phase.tasks) {
                  totalTasks += 1;
                  if (completedSet.has(task.id)) completedTasks += 1;
                  else remainingMinutes += task.estMinutes ?? 0;
                }
              }
              const completionPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);
              const nextUpTaskId = findNextUpTaskId(curriculum, completedSet, activeSet);
              const nextUpHasSession = nextUpTaskId !== null && activeSet.has(nextUpTaskId);
              return (
                <Card.List className="my-auto">
                  <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] border-b border-border">
                    <Card.Raw className="min-w-0 max-lg:border-b lg:border-r border-border">
                      <NextUpPane curriculum={curriculum} taskId={nextUpTaskId} hasSession={nextUpHasSession} />
                    </Card.Raw>
                    <Card.Raw className="min-w-0">
                      <ProgressRingPane percent={completionPercent} remainingMinutes={remainingMinutes} />
                    </Card.Raw>
                  </div>

                  <Card.Entry>
                    <Card.Heading>
                      <Trans>All Sections</Trans>
                    </Card.Heading>
                  </Card.Entry>

                  {curriculum.phases.map((phase, index) => (
                    <PhaseCard
                      key={phase.id}
                      phase={phase}
                      curriculumId={curriculum.id}
                      index={index}
                      completedTaskIds={completedSet}
                    />
                  ))}
                </Card.List>
              );
            }}
          </Pending>
        </BigColumn>
      </PageContent>
    </PageBody>
  );
}

function findNextUpTaskId(
  curriculum: CurriculumDef,
  completedSet: ReadonlySet<string>,
  activeSet: ReadonlySet<string>,
): string | null {
  for (const phase of curriculum.phases) {
    for (const task of phase.tasks) {
      if (activeSet.has(task.id) && !completedSet.has(task.id)) return task.id;
    }
  }
  for (const phase of curriculum.phases) {
    for (const task of phase.tasks) {
      if (!completedSet.has(task.id)) return task.id;
    }
  }
  return null;
}

function NextUpPane({
  curriculum,
  taskId,
  hasSession,
}: {
  curriculum: CurriculumDef;
  taskId: string | null;
  hasSession: boolean;
}) {
  if (!taskId) {
    return (
      <>
        <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-foreground/40">
          <Trans>All done</Trans>
        </div>
        <div className="grow" />
        <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
          <Trans>You finished every topic</Trans>
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <Trans>Revisit any section below to review what you learned.</Trans>
        </p>
      </>
    );
  }
  if (hasSession) return <NextUpWithSession curriculum={curriculum} taskId={taskId} />;
  return <NextUpTaskBody curriculum={curriculum} taskId={taskId} session={undefined} />;
}

function NextUpWithSession({ curriculum, taskId }: { curriculum: CurriculumDef; taskId: string }) {
  const sessionStore = useModelStore(ActiveSessionModel);
  const session$ = useMemo(() => sessionStore.get(taskId), [sessionStore, taskId]);
  return (
    <Pending value$={session$}>
      {(session) => <NextUpTaskBody curriculum={curriculum} taskId={taskId} session={session} />}
    </Pending>
  );
}

function NextUpTaskBody({
  curriculum,
  taskId,
  session,
}: {
  curriculum: CurriculumDef;
  taskId: string;
  session: ActiveSession | undefined;
}) {
  const navigate = useNavigate();
  const apiClient = useApiClient();

  const located = locateTask(curriculum, taskId);
  if (!located) return null;
  const { task, phase } = located;
  const taskUrl = `/topic/${curriculum.id}/${task.id}`;

  async function startOver() {
    await parseResponse(apiClient.api["topic-sessions"][":taskId"].$delete({ param: { taskId: task.id } }));
    navigate(taskUrl);
  }

  const taskPercent = session ? phaseProgressPercent(session) : 0;
  return (
    <>
      <div className="flex items-center gap-3">
        {session && (
          <div className="mb-4">
            <SessionBadge session={session} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg md:text-2xl font-semibold tracking-[-0.03em] text-foreground leading-tight">
          {task.title}
        </h2>
        <p className="text-xs md:text-sm max-w-2xl leading-relaxed text-muted-foreground">
          {task.notes ?? phase.subtitle}
        </p>
      </div>
      <div className="grow" />
      <div className="mt-6 flex items-end justify-between gap-6 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="h-1 rounded-full bg-foreground/10 overflow-hidden">
            <div className="h-full bg-brand transition-[width] duration-500" style={{ width: `${taskPercent}%` }} />
          </div>
          <div className="mt-3 flex items-center gap-2 font-mono text-[11px] tracking-[0.04em] text-foreground/50">
            <span className="text-foreground">{taskPercent}%</span>
            <span>·</span>
            <span className="truncate">{phase.title}</span>
            {task.estMinutes && (
              <>
                <span>·</span>
                <span>~{formatDuration(task.estMinutes)}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col-reverse items-stretch gap-2 w-full sm:flex-row sm:items-center sm:gap-2 sm:w-auto sm:shrink-0">
          {session && (
            <Button size="lg" type="button" onClick={startOver} variant="ghost">
              <Trans>Start over</Trans>
            </Button>
          )}
          <Button size="lg" render={<Link to={taskUrl} />}>
            {session ? <Trans>Continue</Trans> : <Trans>Start</Trans>}
            <ArrowRightIcon weight="bold" data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </>
  );
}

function locateTask(curriculum: CurriculumDef, taskId: string) {
  for (const phase of curriculum.phases) {
    for (const task of phase.tasks) {
      if (task.id === taskId) return { task, phase };
    }
  }
  return null;
}

function SessionBadge({ session }: { session: ActiveSession }) {
  const { partLabel, label } = useSessionLabel(session);
  return (
    <div className="flex items-center gap-1.5">
      {partLabel && <Badge variant="secondary">{partLabel}</Badge>}
      <Badge>{label}</Badge>
    </div>
  );
}

function useSessionLabel(session: ActiveSession): { partLabel: string | null; label: string } {
  const { t } = useLingui();
  const part = (session.partIdx ?? 0) + 1;
  const partLabel = t`Part ${part}`;
  switch (session.name) {
    case "assessing":
      return { partLabel: null, label: t`Assessing` };
    case "gaps-review":
      return { partLabel: null, label: t`Reviewing gaps` };
    case "study":
      return { partLabel, label: t`Study` };
    case "hands-on":
      return { partLabel, label: t`Practice` };
    case "feedback":
      return { partLabel, label: t`Feedback` };
    case "write-up":
      return { partLabel, label: t`Write-up` };
    default: {
      const _exhaustive: never = session.name;
      return _exhaustive;
    }
  }
}

function phaseProgressPercent(session: ActiveSession) {
  const idx = PHASE_ORDER.indexOf(session.name);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / PHASE_ORDER.length) * 100);
}

function ProgressRingPane({ percent, remainingMinutes }: { percent: number; remainingMinutes: number }) {
  return (
    <>
      <div className="lg:hidden">
        <div className="flex items-baseline justify-between gap-2 mb-2">
          <span className="text-foreground font-medium">
            <Trans>Program Completed</Trans>
          </span>
          <span className="font-mono text-sm tabular-nums text-foreground">{percent}%</span>
        </div>
        <div className="h-1 rounded-full bg-foreground/10 overflow-hidden">
          <div className="h-full bg-brand transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
        {remainingMinutes > 0 && (
          <div className="mt-2 font-mono text-[11px] tracking-[0.04em] text-foreground/50">
            ~{formatHours(remainingMinutes)} <Trans>remaining</Trans>
          </div>
        )}
      </div>

      <div className="hidden lg:flex flex-col items-center justify-center text-center">
        <Ring percent={percent} size={148} stroke={8}>
          <span className="text-3xl font-semibold tracking-[-0.03em] text-foreground">{percent}%</span>
        </Ring>
        <div className="text-foreground mt-4">
          <Trans>Program Completed</Trans>
        </div>
        {remainingMinutes > 0 && (
          <div className="text-sm text-foreground/40">
            ~{formatHours(remainingMinutes)} <Trans>remaining</Trans>
          </div>
        )}
      </div>
    </>
  );
}

function formatDuration(minutes: number) {
  if (minutes >= 60) {
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  }
  return `${minutes}m`;
}

function formatHours(minutes: number) {
  if (minutes <= 0) return "0h";
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}
