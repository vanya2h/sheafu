import { Trans } from "@lingui/react/macro";
import { ArrowLeftIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { parseResponse } from "hono/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { redirect, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { Pending } from "rxfy-react";
import { map, shareReplay, startWith, tap } from "rxjs";
import type { Route } from "./+types/curriculum.draft.phases";
import type { DraftLoaderData } from "./curriculum.draft";

import { Card } from "~/components/Card";
import { BuilderActionBar } from "~/components/CurriculumBuilder/BuilderActionBar";
import { SelectableCard } from "~/components/CurriculumBuilder/SelectableCard";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { type OutlinePhase, parsePhase, type Phase, type Task } from "~/data/types";
import { apiClient } from "~/lib/apiClient";
import { getApiErrorMessage } from "~/lib/errors";
import { parseJSON } from "~/lib/json";
import { createLlmStream } from "~/lib/llmStream";
import { getCurriculumLinks } from "~/lib/routes";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";
import { useLocale } from "~app/hooks/useLocale";

export async function loader({ request, params }: Route.LoaderArgs) {
  const session = await requireSession(request);
  const draft = await db.customCurriculum.findFirst({
    where: { id: params.id, userId: session.user.id },
  });
  const links = getCurriculumLinks();
  if (!draft) throw redirect(links.new);
  if (draft.status === "published") throw redirect(links.byId(draft.id));
  if (!draft.outline) throw redirect(links.draft(draft.id).outline);
  return null;
}

type Selections = DraftLoaderData["draft"]["selections"];

type PhaseState =
  | { status: "streaming"; phase: Phase | null }
  | { status: "complete"; phase: Phase | null }
  | { status: "error"; message: string };

export default function DraftPhasesPage() {
  const layoutData = useRouteLoaderData<DraftLoaderData>("routes/curriculum.draft");
  const { id, phaseId } = useParams<{ id: string; phaseId: string }>();

  const outline = layoutData?.draft.outline ?? null;
  const selections = layoutData?.draft.selections ?? null;
  const generatedPhases = layoutData?.draft.generatedPhases ?? {};
  const selectedPhaseIds = selections?.selectedPhaseIds ?? [];

  if (!id || !phaseId) return null;

  const orderedSelected = (outline?.phases ?? []).filter((p) => selectedPhaseIds.includes(p.id));
  const currentIdx = orderedSelected.findIndex((p) => p.id === phaseId);
  const outlinePhase = currentIdx >= 0 ? orderedSelected[currentIdx] : undefined;

  if (!outlinePhase) {
    return (
      <PageBody>
        <PageContent>
          <ReadingColumn>
            <p className="text-sm text-muted-foreground">
              <Trans>Phase not found.</Trans>
            </p>
          </ReadingColumn>
        </PageContent>
      </PageBody>
    );
  }

  const allSelectedDone = orderedSelected.every((p) => parsePhase(generatedPhases[p.id]));
  const persistedPhase = parsePhase(generatedPhases[phaseId]);

  if (persistedPhase) {
    return (
      <PhaseIdleView
        id={id}
        outlinePhase={outlinePhase}
        phase={persistedPhase}
        selections={selections}
        currentIdx={currentIdx}
        orderedSelected={orderedSelected}
        allSelectedDone={allSelectedDone}
      />
    );
  }

  return (
    <PhaseStreamView
      id={id}
      phaseId={phaseId}
      outlinePhase={outlinePhase}
      selections={selections}
      currentIdx={currentIdx}
      orderedSelected={orderedSelected}
      allSelectedDone={allSelectedDone}
    />
  );
}

function PhaseIdleView({
  id,
  outlinePhase,
  phase,
  selections,
  currentIdx,
  orderedSelected,
  allSelectedDone,
}: {
  id: string;
  outlinePhase: OutlinePhase;
  phase: Phase;
  selections: Selections;
  currentIdx: number;
  orderedSelected: OutlinePhase[];
  allSelectedDone: boolean;
}) {
  const { revalidate } = useRevalidator();
  const [optimisticDeselected, setOptimisticDeselected] = useState<string[] | null>(null);
  const toggleFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deselectedTaskIds = new Set(optimisticDeselected ?? selections?.deselectedTaskIds ?? []);

  useEffect(() => {
    return () => {
      if (toggleFlushRef.current) clearTimeout(toggleFlushRef.current);
    };
  }, []);

  function toggleTask(taskId: string) {
    if (!selections) return;
    const next = new Set(deselectedTaskIds);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    const nextArray = [...next];
    setOptimisticDeselected(nextArray);

    if (toggleFlushRef.current) clearTimeout(toggleFlushRef.current);
    toggleFlushRef.current = setTimeout(() => {
      toggleFlushRef.current = null;
      void (async () => {
        try {
          await parseResponse(
            apiClient.api.curriculums.drafts[":id"].$patch({
              param: { id },
              json: {
                selections: {
                  selectedPhaseIds: selections.selectedPhaseIds,
                  deselectedTaskIds: nextArray,
                  currentPhaseIdx: selections.currentPhaseIdx,
                },
              },
            }),
          );
          await revalidate();
        } finally {
          setOptimisticDeselected(null);
        }
      })();
    }, 500);
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <PhaseHeading outlinePhase={outlinePhase} currentIdx={currentIdx} total={orderedSelected.length} />
            {phase.tasks.map((task) => (
              <SelectableCard
                key={task.id}
                selected={!deselectedTaskIds.has(task.id)}
                readOnly={false}
                onToggle={() => toggleTask(task.id)}
                title={<TaskTitle task={task} />}
              />
            ))}
          </Card.List>
        </ReadingColumn>
      </PageContent>

      <PhaseNav
        id={id}
        currentIdx={currentIdx}
        orderedSelected={orderedSelected}
        selections={selections}
        allSelectedDone={allSelectedDone}
        disabled={false}
      />
    </PageBody>
  );
}

function PhaseStreamView({
  id,
  phaseId,
  outlinePhase,
  selections,
  currentIdx,
  orderedSelected,
  allSelectedDone,
}: {
  id: string;
  phaseId: string;
  outlinePhase: OutlinePhase;
  selections: Selections;
  currentIdx: number;
  orderedSelected: OutlinePhase[];
  allSelectedDone: boolean;
}) {
  const { revalidate } = useRevalidator();
  const locale = useLocale();

  const stream = useMemo(
    () =>
      createLlmStream((signal) =>
        apiClient.api.curriculums.drafts[":id"]["generate-phase"].$post(
          { param: { id }, json: { phaseId, locale } },
          { init: { signal } },
        ),
      ),
    [id, phaseId, locale],
  );

  const viewState$ = useMemo(
    () =>
      stream.state$.pipe(
        map((s): PhaseState => {
          if (s.status === "error") {
            return { status: "error", message: getApiErrorMessage(s.error, "Failed to generate phase") };
          }
          let phase: Phase | null = null;
          try {
            phase = parsePhase(parseJSON<unknown>(s.text)) ?? null;
          } catch {
            // partial stream not yet parseable
          }
          return { status: s.status === "complete" ? "complete" : "streaming", phase };
        }),
        tap((s) => {
          if (s.status === "complete") revalidate();
        }),
        startWith<PhaseState>({ status: "streaming", phase: null }),
        shareReplay({ bufferSize: 1, refCount: false }),
      ),
    [stream, revalidate],
  );

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Pending value$={viewState$} getDefaultValue={() => ({ status: "streaming", phase: null }) as PhaseState}>
            {(state) => {
              const isStreaming = state.status === "streaming";
              const errorMsg = state.status === "error" ? state.message : null;
              const phase = state.status === "error" ? null : state.phase;

              return (
                <>
                  {errorMsg && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{errorMsg}</p>}
                  <Card.List>
                    <PhaseHeading outlinePhase={outlinePhase} currentIdx={currentIdx} total={orderedSelected.length} />

                    {isStreaming && !phase && (
                      <Card.Entry className="flex items-center gap-2 text-foreground/40">
                        <Spinner />
                        <p className="text-sm">
                          <Trans>Generating phase…</Trans>
                        </p>
                      </Card.Entry>
                    )}

                    {(phase?.tasks.length || 0) > 0 &&
                      phase?.tasks.map((task) => (
                        <SelectableCard key={task.id} selected readOnly title={<TaskTitle task={task} />} />
                      ))}
                  </Card.List>
                </>
              );
            }}
          </Pending>
        </ReadingColumn>
      </PageContent>

      <Pending value$={viewState$} getDefaultValue={() => ({ status: "streaming", phase: null }) as PhaseState}>
        {(state) => (
          <PhaseNav
            id={id}
            currentIdx={currentIdx}
            orderedSelected={orderedSelected}
            selections={selections}
            allSelectedDone={allSelectedDone}
            disabled={state.status === "streaming"}
          />
        )}
      </Pending>
    </PageBody>
  );
}

function PhaseHeading({
  outlinePhase,
  currentIdx,
  total,
}: {
  outlinePhase: OutlinePhase;
  currentIdx: number;
  total: number;
}) {
  return (
    <Card.Entry className="flex items-baseline justify-between gap-4">
      <div className="flex flex-col gap-2">
        <Card.Heading>{outlinePhase.title}</Card.Heading>
        {outlinePhase.subtitle && <Card.SubHeading>{outlinePhase.subtitle}</Card.SubHeading>}
      </div>
      <span className="hidden md:inline shrink-0 font-mono text-[11px] tracking-[0.04em] text-foreground/40 tabular-nums">
        <Trans>
          Phase {currentIdx + 1} of {total}
        </Trans>
      </span>
    </Card.Entry>
  );
}

function PhaseNav({
  id,
  currentIdx,
  orderedSelected,
  selections,
  allSelectedDone,
  disabled,
}: {
  id: string;
  currentIdx: number;
  orderedSelected: OutlinePhase[];
  selections: Selections;
  allSelectedDone: boolean;
  disabled: boolean;
}) {
  const navigate = useNavigate();
  const total = orderedSelected.length;
  const isFirst = currentIdx === 0;
  const isLast = currentIdx === total - 1;

  function navigateTo(idx: number) {
    const target = orderedSelected[idx];
    if (!target) return;
    if (selections) {
      void apiClient.api.curriculums.drafts[":id"].$patch({
        param: { id },
        json: {
          selections: {
            selectedPhaseIds: selections.selectedPhaseIds,
            deselectedTaskIds: selections.deselectedTaskIds,
            currentPhaseIdx: idx,
          },
        },
      });
    }
    void navigate(getCurriculumLinks().draft(id).phases(target.id));
  }

  async function finishAndPublish() {
    const result = await parseResponse(apiClient.api.curriculums.drafts[":id"].publish.$post({ param: { id } }));
    void navigate(getCurriculumLinks().draft(result.id).finish);
  }

  return (
    <BuilderActionBar>
      <Button variant="outline" disabled={isFirst || disabled} onClick={() => navigateTo(currentIdx - 1)}>
        <ArrowLeftIcon /> <Trans>Previous</Trans>
      </Button>

      {isLast && allSelectedDone ? (
        <Button className="ml-auto" disabled={disabled} onClick={() => void finishAndPublish()}>
          <Trans>Finish</Trans> <ArrowRightIcon />
        </Button>
      ) : (
        <Button className="ml-auto" disabled={isLast || disabled} onClick={() => navigateTo(currentIdx + 1)}>
          <Trans>Next</Trans> <ArrowRightIcon />
        </Button>
      )}
    </BuilderActionBar>
  );
}

function TaskTitle({ task }: { task: Task }) {
  return (
    <span className="text-sm leading-snug">
      {task.title}
      {task.estMinutes !== undefined && (
        <span className="ml-2 text-xs text-muted-foreground font-normal">
          ~{task.estMinutes >= 60 ? `${Math.round(task.estMinutes / 60)}h` : `${task.estMinutes}m`}
        </span>
      )}
    </span>
  );
}
