import { Trans } from "@lingui/react/macro";
import { ArrowLeftIcon, ArrowRightIcon } from "@phosphor-icons/react";
import isEqual from "lodash/isEqual";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLoaderData, useNavigate, useParams, useRouteLoaderData } from "react-router";
import { createAtom } from "rxfy";
import { Pending } from "rxfy-react";
import { combineLatest, distinctUntilChanged, filter, map, skip, tap } from "rxjs";
import type { Route } from "./+types/topic.study";
import type { loader as layoutLoader } from "./topic-layout";

import { Card } from "~/components/Card";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { Markdown } from "~/components/Markdown";
import { TopicActionBar } from "~/components/TopicActionBar";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useTopicSession } from "~/hooks/useTopicSession";
import { useApiClient } from "~/lib/apiClient";
import { getApiErrorMessage } from "~/lib/errors";
import type { Locale } from "~/lib/i18n";
import { getLlmStream } from "~/lib/llmStream";
import type { Material, PhaseByKey } from "~/lib/phase";
import { isPhaseReadOnly, parsePart, parsePlan, parseTopicSessionState } from "~/lib/phase";
import { getTopicLinks } from "~/lib/routes";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";
import { useLocale } from "~app/hooks/useLocale";

type LoaderResult = (PhaseByKey<"study"> | PhaseByKey<"gaps-review"> | { name: null }) & { readOnly: boolean };

type StreamError = { kind: "rate-limit" | "generic"; message: string };

function toStreamError(err: unknown): StreamError {
  if (err instanceof Error && "statusCode" in err && (err as { statusCode?: unknown }).statusCode === 429) {
    return { kind: "rate-limit", message: getApiErrorMessage(err, "") };
  }
  return { kind: "generic", message: getApiErrorMessage(err, String(err)) };
}

type MaterialUpdate =
  | { kind: "plan"; plan: Material["plan"]; assessmentContext: string | undefined }
  | { kind: "part"; idx: number; part: NonNullable<Material["parts"][number]> };

function reduceMaterial(acc: Material | null, update: MaterialUpdate): Material | null {
  if (update.kind === "plan") {
    if (acc) return acc;
    return {
      plan: update.plan,
      parts: Array<NonNullable<Material["parts"][number]> | null>(update.plan.partPlans.length).fill(null),
      assessmentContext: update.assessmentContext,
    };
  }
  if (acc === null || acc.parts[update.idx]) return acc;
  return {
    ...acc,
    parts: acc.parts.map((p, i) => (i === update.idx ? update.part : p)),
  };
}

// Three branches map to three distinct study-page entry states:
//   - `study` phase exists → resume an in-progress study session (has `material` + `partIdx`).
//   - `gaps-review` phase exists (no `study` yet) → first time on study page; we read the
//     `context` string produced by topic.gaps.tsx and forward it as `assessmentContext` to
//     seed the study-plan LLM call. We are NOT rendering gaps here.
//   - neither → first time on study page with assessment skipped; generate a plan with no context.
export async function loader({ request, params }: Route.LoaderArgs): Promise<LoaderResult> {
  const session = await requireSession(request);
  const record = await db.topicSession.findUnique({
    where: {
      userId_taskId: {
        userId: session.user.id,
        taskId: params.taskId,
      },
    },
  });
  const state = record ? parseTopicSessionState(record.phaseData) : { phases: {} };
  const readOnly = isPhaseReadOnly(state, "study");

  const study = state.phases.study;
  if (study) {
    return { ...study, readOnly };
  }
  const gaps = state.phases["gaps-review"];
  if (gaps) {
    return { ...gaps, readOnly };
  }
  return { name: null, readOnly };
}

type LayoutData = NonNullable<ReturnType<typeof useRouteLoaderData<typeof layoutLoader>>>;

export default function StudyPage() {
  const loaderData = useLoaderData<typeof loader>();
  const layoutData = useRouteLoaderData<typeof layoutLoader>("routes/topic-layout");
  const { taskId, curriculumId } = useParams<{ taskId: string; curriculumId: string }>();
  const locale = useLocale();

  if (!layoutData?.task || !taskId || !curriculumId) return null;

  return (
    <StudyView
      taskId={taskId}
      task={layoutData.task}
      curriculumName={layoutData.curriculumName ?? ""}
      complexity={layoutData.complexity}
      locale={locale}
      readOnly={loaderData.readOnly}
      initialMaterial={loaderData.name === "study" ? loaderData.material : null}
      initialPartIdx={loaderData.name === "study" ? loaderData.partIdx : 0}
      assessmentContext={loaderData.name === "gaps-review" ? loaderData.context : undefined}
      handsOnRoute={getTopicLinks(curriculumId, taskId).handsOn}
    />
  );
}

type StudyViewProps = {
  taskId: string;
  task: LayoutData["task"];
  curriculumName: string;
  complexity: LayoutData["complexity"];
  locale: Locale;
  readOnly: boolean;
  initialMaterial: Material | null;
  initialPartIdx: number;
  assessmentContext: string | undefined;
  handsOnRoute: string;
};

function StudyView({
  taskId,
  task,
  curriculumName,
  complexity,
  locale,
  readOnly,
  initialMaterial,
  initialPartIdx,
  assessmentContext,
  handsOnRoute,
}: StudyViewProps) {
  const navigate = useNavigate();
  const apiClient = useApiClient();
  const { saveSession: rawSaveSession } = useTopicSession(taskId);

  const [material$] = useState(() => createAtom<Material | null>(initialMaterial));
  const [partIdx$] = useState(() => createAtom<number>(initialPartIdx));

  const saveSession = useCallback<typeof rawSaveSession>(
    (phase) =>
      readOnly ? (Promise.resolve({ ok: true } as never) as ReturnType<typeof rawSaveSession>) : rawSaveSession(phase),
    [readOnly, rawSaveSession],
  );

  const viewState$ = useMemo(
    () => combineLatest([material$, partIdx$]).pipe(map(([material, partIdx]) => ({ material, partIdx }))),
    [material$, partIdx$],
  );

  const planStream = useMemo(() => {
    if (initialMaterial !== null) return null;
    const stream = getLlmStream(`study-plan:${locale}:${taskId}`, (signal) =>
      apiClient.api.llm["study-plan"].$post(
        {
          json: {
            topic: task.title,
            curriculum: curriculumName,
            complexity,
            assessmentContext,
            locale,
          },
        },
        { init: { signal } },
      ),
    );
    return {
      retry: stream.retry,
      state$: stream.state$.pipe(
        tap((state) => {
          if (state.status !== "complete") return;
          material$.modify((prev) =>
            reduceMaterial(prev, { kind: "plan", plan: parsePlan(state.text), assessmentContext }),
          );
          partIdx$.set(0);
        }),
      ),
    };
  }, [
    apiClient,
    task,
    taskId,
    curriculumName,
    complexity,
    assessmentContext,
    locale,
    initialMaterial,
    material$,
    partIdx$,
  ]);

  const partStream$ = useMemo(
    () =>
      combineLatest([material$, partIdx$]).pipe(
        distinctUntilChanged(isEqual),
        map(([m, idx]) => {
          if (!m || m.parts[idx]) return null;
          const stream = getLlmStream(`study-part:${locale}:${taskId}:${idx}`, (signal) =>
            apiClient.api.llm["study-part"].$post(
              {
                json: {
                  topic: task.title,
                  curriculum: curriculumName,
                  complexity,
                  assessmentContext: m.assessmentContext,
                  partIdx: idx,
                  parts: m.plan.partPlans,
                  locale,
                },
              },
              { init: { signal } },
            ),
          );
          return {
            retry: stream.retry,
            state$: stream.state$.pipe(
              tap((state) => {
                if (state.status !== "complete") return;
                material$.modify((prev) => reduceMaterial(prev, { kind: "part", idx, part: parsePart(state.text) }));
              }),
            ),
          };
        }),
      ),
    [apiClient, material$, partIdx$, task, taskId, locale, curriculumName, complexity],
  );

  useEffect(() => {
    const sub = combineLatest([material$, partIdx$])
      .pipe(
        skip(1),
        distinctUntilChanged(isEqual),
        filter(([m]) => m !== null),
        tap(
          ([m, idx]) =>
            void saveSession({
              name: "study",
              material: m as Material,
              partIdx: idx,
            }),
        ),
      )
      .subscribe();
    return () => sub.unsubscribe();
  }, [material$, partIdx$, saveSession]);

  function handleMoveToHandsOn(material: Material, partIdx: number) {
    void saveSession({
      name: "hands-on",
      material,
      partIdx,
      answers: {},
    });
    void navigate(handsOnRoute);
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <Pending
              value$={viewState$}
              getDefaultValue={() => ({ material: initialMaterial, partIdx: initialPartIdx })}
            >
              {({ material, partIdx }) => {
                const partPlan = material?.plan.partPlans[partIdx];
                const totalParts = material?.plan.partPlans.length ?? 0;
                const headingTitle = partPlan?.title ?? task.title;
                const headingDescription = partPlan?.description;
                const part = material?.parts[partIdx];
                return (
                  <>
                    <Card.Entry className="flex items-baseline justify-between gap-4">
                      <div className="flex flex-col gap-2">
                        <Card.Heading>{headingTitle}</Card.Heading>
                        {headingDescription && <Card.SubHeading>{headingDescription}</Card.SubHeading>}
                      </div>
                      {material && (
                        <span className="shrink-0 font-mono text-[11px] tracking-[0.04em] text-foreground/40 tabular-nums">
                          <Trans>
                            Part {partIdx + 1} of {totalParts}
                          </Trans>
                        </span>
                      )}
                    </Card.Entry>

                    {!material && planStream && (
                      <Pending value$={planStream.state$} pending={<LoadingEntry />}>
                        {(state) =>
                          state.status === "error" ? (
                            <ErrorEntry error={state.error} onRetry={() => planStream.retry()} />
                          ) : (
                            <LoadingEntry />
                          )
                        }
                      </Pending>
                    )}

                    {part && (
                      <Card.Entry>
                        <Markdown>{part.study}</Markdown>
                      </Card.Entry>
                    )}
                  </>
                );
              }}
            </Pending>

            <Pending value$={partStream$} getDefaultValue={() => null}>
              {(stream) =>
                stream === null ? null : (
                  <Pending value$={stream.state$} pending={<LoadingEntry />}>
                    {(state) => {
                      if (state.status === "error") {
                        return <ErrorEntry error={state.error} onRetry={() => stream.retry()} />;
                      }
                      if (state.text === "") return <LoadingEntry />;
                      try {
                        const parsed = parsePart(state.text);
                        if (!parsed.study) return <LoadingEntry />;
                        return (
                          <Card.Entry>
                            <Markdown isAnimating>{parsed.study}</Markdown>
                          </Card.Entry>
                        );
                      } catch {
                        return <LoadingEntry />;
                      }
                    }}
                  </Pending>
                )
              }
            </Pending>
          </Card.List>
        </ReadingColumn>
      </PageContent>

      <Pending value$={viewState$} getDefaultValue={() => ({ material: initialMaterial, partIdx: initialPartIdx })}>
        {({ material, partIdx }) => {
          if (!material) return null;
          const part = material.parts[partIdx];
          const totalParts = material.plan.partPlans.length;
          const isLastPart = partIdx === totalParts - 1;
          const prevPlan = partIdx > 0 ? material.plan.partPlans[partIdx - 1] : null;
          return (
            <TopicActionBar>
              <Button
                variant="outline"
                disabled={!prevPlan || !material.parts[partIdx - 1]}
                onClick={() => partIdx$.set(partIdx - 1)}
              >
                <ArrowLeftIcon /> <Trans>Previous</Trans>
              </Button>

              {isLastPart ? (
                <Button className="ml-auto" disabled={!part} onClick={() => handleMoveToHandsOn(material, partIdx)}>
                  <Trans>Practice</Trans> <ArrowRightIcon />
                </Button>
              ) : (
                <Button className="ml-auto" disabled={!part} onClick={() => partIdx$.set(partIdx + 1)}>
                  <Trans>Next</Trans> <ArrowRightIcon />
                </Button>
              )}
            </TopicActionBar>
          );
        }}
      </Pending>
    </PageBody>
  );
}

function LoadingEntry() {
  return (
    <Card.Entry className="flex flex-row items-center gap-2 text-foreground/40">
      <Spinner />
      <p className="text-sm">
        <Trans>Preparing your study material…</Trans>
      </p>
    </Card.Entry>
  );
}

function ErrorEntry({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const classified = toStreamError(error);
  if (classified.kind === "rate-limit") {
    return (
      <Card.Entry className="flex flex-col gap-2">
        <p className="text-sm text-foreground">
          <Trans>You&apos;ve hit your hourly LLM usage limit. Try again later.</Trans>
        </p>
        {classified.message && <p className="text-xs text-muted-foreground">{classified.message}</p>}
      </Card.Entry>
    );
  }
  return (
    <Card.Entry className="flex flex-col items-start gap-3">
      <p className="text-sm text-foreground">
        <Trans>Couldn&apos;t prepare your study material.</Trans>
      </p>
      {classified.message && <p className="text-xs text-muted-foreground">{classified.message}</p>}
      <Button variant="outline" size="sm" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </Card.Entry>
  );
}
