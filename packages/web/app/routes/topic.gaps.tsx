import { Trans } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { useLoaderData, useNavigate, useParams } from "react-router";
import { Pending } from "rxfy-react";
import { map, shareReplay, tap } from "rxjs";
import type { Route } from "./+types/topic.gaps";

import { Card } from "~/components/Card";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { TopicActionBar } from "~/components/TopicActionBar";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useTopicSession } from "~/hooks/useTopicSession";
import { apiClient } from "~/lib/apiClient";
import { parseJSON } from "~/lib/json";
import { createLlmStream, type LlmStream } from "~/lib/llmStream";
import type { GapEntry, GapItem, GapLevel, PhaseByKey } from "~/lib/phase";
import { isLegacyGap, isPhaseReadOnly, parseTopicSessionState } from "~/lib/phase";
import { getTopicLinks } from "~/lib/routes";
import { cn } from "~/lib/utils";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";
import { useLocale } from "~app/hooks/useLocale";

const VALID_LEVELS = ["partially-known", "no-knowledge"] as const satisfies readonly GapLevel[];

type LoaderResult = (PhaseByKey<"gaps-review"> | PhaseByKey<"assessing">) & { readOnly: boolean };

type GapsStreamState =
  | { status: "streaming"; text: string }
  | { status: "complete"; text: string; review: PhaseByKey<"gaps-review"> | null }
  | { status: "error"; error: unknown };

type AssessingData = PhaseByKey<"assessing"> & { readOnly: boolean };

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
  const readOnly = isPhaseReadOnly(state, "gaps-review");

  const review = state.phases["gaps-review"];
  if (review) return { ...review, readOnly };
  const assessing = state.phases.assessing;
  if (assessing) return { ...assessing, readOnly };
  return { name: "assessing" as const, questions: [], answers: {}, readOnly };
}

export default function GapsPage() {
  const data = useLoaderData<typeof loader>();
  if (data.name === "gaps-review") return <GapsReviewDisplay review={data} />;
  return <GapsAssessmentView data={data} />;
}

function GapsReviewDisplay({ review }: { review: PhaseByKey<"gaps-review"> & { readOnly: boolean } }) {
  const { curriculumId, taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <GapsReviewCards review={review} />
          </Card.List>
        </ReadingColumn>
      </PageContent>
      {!review.readOnly && (
        <TopicActionBar>
          <Button className="ml-auto" onClick={() => void navigate(getTopicLinks(curriculumId!, taskId!).study)}>
            <Trans>Start studying</Trans>
          </Button>
        </TopicActionBar>
      )}
    </PageBody>
  );
}

function GapsAssessmentView({ data }: { data: AssessingData }) {
  const { curriculumId, taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  const { saveSession } = useTopicSession(taskId!);
  const locale = useLocale();

  const [stream] = useState<LlmStream>(() => {
    const qa = data.questions.map((q, i) => ({ q, a: data.answers[i] ?? "" }));
    return createLlmStream((signal) => apiClient.api.llm.gaps.$post({ json: { qa, locale } }, { init: { signal } }));
  });

  const state$ = useMemo(
    () =>
      stream.state$.pipe(
        map((s): GapsStreamState => {
          if (s.status !== "complete") return s;
          try {
            const { summary, gaps } = parseJSON<{ summary: string; gaps: unknown[] }>(s.text);
            const cleanGaps = Array.isArray(gaps) ? gaps.filter(isGapItem) : [];
            const context =
              cleanGaps.length > 0
                ? `Learner level: ${summary}. Key gaps to focus on: ${cleanGaps.map((g) => g.title).join(", ")}.`
                : `Learner level: ${summary}. Knowledge is solid — go deep and cover advanced nuances.`;
            return {
              status: "complete",
              text: s.text,
              review: { name: "gaps-review" as const, summary, gaps: cleanGaps, context },
            };
          } catch {
            return { status: "complete", text: s.text, review: null };
          }
        }),
        tap((s) => {
          if (s.status === "complete" && s.review) void saveSession(s.review);
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      ),
    [stream, saveSession],
  );

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <Pending value$={state$}>
              {(state) => {
                if (state.status === "complete" && state.review) {
                  return <GapsReviewCards review={state.review} />;
                }
                if (state.status === "error") {
                  return (
                    <>
                      <Card.Entry className="flex items-baseline justify-between gap-4">
                        <Card.Heading>
                          <Trans>Evaluating your answers…</Trans>
                        </Card.Heading>
                      </Card.Entry>
                      <Card.Entry className="flex flex-row items-center gap-2 text-destructive">
                        <p className="text-sm">
                          <Trans>Failed to evaluate answers.</Trans>
                        </p>
                        <Button variant="secondary" size="sm" onClick={() => stream.retry()}>
                          <Trans>Retry</Trans>
                        </Button>
                      </Card.Entry>
                    </>
                  );
                }
                const partial = tryParseReview(state.text);
                const gaps = partial?.gaps ?? [];
                return (
                  <>
                    <Card.Entry className="flex items-baseline justify-between gap-4">
                      <div className="flex flex-col gap-2">
                        <Card.Heading>
                          <Trans>Evaluating your answers…</Trans>
                        </Card.Heading>
                        {partial?.summary && <Card.SubHeading>{partial.summary}</Card.SubHeading>}
                      </div>
                    </Card.Entry>
                    {gaps.length === 0 && (
                      <Card.Entry className="flex flex-row items-center gap-2 text-foreground/40">
                        <Spinner />
                        <p className="text-sm">
                          <Trans>Identifying gaps…</Trans>
                        </p>
                      </Card.Entry>
                    )}
                    {gaps.map((gap, i) => (
                      <GapRow key={i} gap={gap} />
                    ))}
                  </>
                );
              }}
            </Pending>
          </Card.List>
        </ReadingColumn>
      </PageContent>

      {!data.readOnly && (
        <Pending value$={state$}>
          {(state) => (
            <TopicActionBar>
              <Button
                className="ml-auto"
                disabled={!(state.status === "complete" && state.review)}
                onClick={() => void navigate(getTopicLinks(curriculumId!, taskId!).study)}
              >
                <Trans>Start studying</Trans>
              </Button>
            </TopicActionBar>
          )}
        </Pending>
      )}
    </PageBody>
  );
}

function GapsReviewCards({ review }: { review: PhaseByKey<"gaps-review"> }) {
  return (
    <>
      <Card.Entry className="flex items-baseline justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Card.Heading>
            <Trans>Here&apos;s what your assessment showed</Trans>
          </Card.Heading>
          {review.summary && <Card.SubHeading>{review.summary}</Card.SubHeading>}
        </div>
        {review.gaps.length > 0 && (
          <span className="font-mono text-[11px] tracking-[0.04em] text-foreground/40 tabular-nums">
            {review.gaps.length} <Trans>gaps</Trans>
            {review.gaps.filter((g) => !isLegacyGap(g) && g.level === "partially-known").length > 0 && (
              <>
                {" · "}
                {review.gaps.filter((g) => !isLegacyGap(g) && g.level === "partially-known").length}{" "}
                <Trans>partially known</Trans>
              </>
            )}
          </span>
        )}
      </Card.Entry>

      {review.gaps.length === 0 && (
        <Card.Entry className="text-sm text-muted-foreground">
          <Trans>No significant gaps detected — the material will go deep on advanced nuances.</Trans>
        </Card.Entry>
      )}

      {review.gaps.map((gap, i) => (
        <GapRow key={i} gap={gap} />
      ))}
    </>
  );
}

function GapRow({ gap }: { gap: GapEntry }) {
  if (isLegacyGap(gap)) {
    // TODO(legacy gaps): drop this branch once all stored gaps-review sessions
    // have been re-generated under the new {title, description, level} shape.
    return (
      <Card.Entry>
        <p className="text-sm font-medium text-foreground">{gap}</p>
      </Card.Entry>
    );
  }
  return (
    <Card.Entry className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{gap.title}</p>
        {gap.description && <p className="mt-1 text-sm text-muted-foreground">{gap.description}</p>}
      </div>
      <LevelPill level={gap.level} />
    </Card.Entry>
  );
}

function LevelPill({ level }: { level: GapLevel }) {
  const isPartial = level === "partially-known";
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] uppercase",
        isPartial ? "text-amber-500 dark:text-amber-400" : "text-foreground/40",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", isPartial ? "bg-amber-500 dark:bg-amber-400" : "bg-foreground/30")}
        aria-hidden
      />
      {isPartial ? <Trans>Partial</Trans> : <Trans>Gap</Trans>}
    </span>
  );
}

function tryParseReview(text: string): { summary?: string; gaps?: GapItem[] } | null {
  try {
    const partial = parseJSON<{ summary?: unknown; gaps?: unknown }>(text);
    return {
      summary: typeof partial.summary === "string" ? partial.summary : undefined,
      gaps: Array.isArray(partial.gaps) ? partial.gaps.filter(isGapItem) : undefined,
    };
  } catch {
    return null;
  }
}

function isGapItem(value: unknown): value is GapItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.description === "string" &&
    typeof v.level === "string" &&
    (VALID_LEVELS as readonly string[]).includes(v.level)
  );
}
