import { Trans } from "@lingui/react/macro";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useLoaderData, useNavigate, useParams } from "react-router";
import { Pending } from "rxfy-react";
import { shareReplay, tap } from "rxjs";
import type { Route } from "./+types/topic.feedback";

import { Card } from "~/components/Card";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { Markdown } from "~/components/Markdown";
import { TopicActionBar } from "~/components/TopicActionBar";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useTopicSession } from "~/hooks/useTopicSession";
import { apiClient } from "~/lib/apiClient";
import { createLlmStream, type LlmStream } from "~/lib/llmStream";
import type { PhaseByKey } from "~/lib/phase";
import { isPhaseReadOnly, parseTopicSessionState } from "~/lib/phase";
import { getTopicLinks } from "~/lib/routes";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";
import { useLocale } from "~app/hooks/useLocale";

type LoaderResult = (PhaseByKey<"feedback"> | PhaseByKey<"hands-on">) & { readOnly: boolean };

type FeedbackData = PhaseByKey<"feedback"> & { readOnly: boolean };
type HandsOnData = PhaseByKey<"hands-on"> & { readOnly: boolean };

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
  const readOnly = isPhaseReadOnly(state, "feedback");

  const feedback = state.phases.feedback;
  if (feedback) return { ...feedback, readOnly };
  const handsOn = state.phases["hands-on"];
  if (handsOn) return { ...handsOn, readOnly };
  throw new Response("Not found", { status: 404 });
}

export default function FeedbackPage() {
  const data = useLoaderData<typeof loader>();
  if (data.name === "feedback") return <FeedbackDisplay data={data} />;
  return <HandsOnFeedbackView data={data} />;
}

function FeedbackDisplay({ data }: { data: FeedbackData }) {
  const { curriculumId, taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  const { saveSession } = useTopicSession(taskId!);

  const { material, partIdx } = data;
  const partPlan = material.plan.partPlans[partIdx];

  function handleContinue() {
    void saveSession({ name: "write-up", material, partIdx, feedback: "" });
    void navigate(getTopicLinks(curriculumId!, taskId!).writeUp);
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <FeedbackHeading partPlan={partPlan} />
            <Card.Entry>
              <Markdown>{data.feedback}</Markdown>
            </Card.Entry>
          </Card.List>
        </ReadingColumn>
      </PageContent>
      {!data.readOnly && (
        <TopicActionBar>
          <Button className="ml-auto" onClick={handleContinue}>
            <Trans>Reflection</Trans> <ArrowRightIcon />
          </Button>
        </TopicActionBar>
      )}
    </PageBody>
  );
}

function HandsOnFeedbackView({ data }: { data: HandsOnData }) {
  const { curriculumId, taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  const { saveSession } = useTopicSession(taskId!);
  const locale = useLocale();

  const { material, partIdx, answers } = data;
  const part = material.parts[partIdx]!;
  const partPlan = material.plan.partPlans[partIdx];

  const [stream] = useState<LlmStream>(() => {
    const qa = part.handsOn.map((t, i) => ({ task: t.task, answer: answers[i] ?? "" }));
    return createLlmStream((signal) =>
      apiClient.api.llm["hands-on-feedback"].$post({ json: { qa, locale } }, { init: { signal } }),
    );
  });

  const state$ = useMemo(
    () =>
      stream.state$.pipe(
        tap((state) => {
          if (state.status !== "complete") return;
          void saveSession({ name: "feedback", material, partIdx, answers, feedback: state.text });
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      ),
    [stream, saveSession, material, partIdx, answers],
  );

  function handleContinue() {
    void saveSession({ name: "write-up", material, partIdx, feedback: "" });
    void navigate(getTopicLinks(curriculumId!, taskId!).writeUp);
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <FeedbackHeading partPlan={partPlan} />
            <Pending value$={state$}>
              {(state) => {
                if (state.status === "error") {
                  return (
                    <Card.Entry className="flex flex-row items-center gap-2 text-destructive">
                      <p className="text-sm">
                        <Trans>Failed to generate feedback.</Trans>
                      </p>
                      <Button variant="secondary" size="sm" onClick={() => stream.retry()}>
                        <Trans>Retry</Trans>
                      </Button>
                    </Card.Entry>
                  );
                }
                if (state.status === "complete") {
                  return (
                    <Card.Entry>
                      <Markdown>{state.text}</Markdown>
                    </Card.Entry>
                  );
                }
                return (
                  <>
                    {!state.text && (
                      <Card.Entry className="flex flex-row items-center gap-2 text-foreground/40">
                        <Spinner />
                        <p className="text-sm">
                          <Trans>Evaluating your answers…</Trans>
                        </p>
                      </Card.Entry>
                    )}
                    {state.text && (
                      <Card.Entry>
                        <Markdown isAnimating>{state.text}</Markdown>
                      </Card.Entry>
                    )}
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
              <Button className="ml-auto" disabled={state.status !== "complete"} onClick={handleContinue}>
                <Trans>Reflection</Trans> <ArrowRightIcon />
              </Button>
            </TopicActionBar>
          )}
        </Pending>
      )}
    </PageBody>
  );
}

function FeedbackHeading({ partPlan }: { partPlan: { title?: string; description?: string } | undefined }) {
  return (
    <Card.Entry className="flex items-baseline justify-between gap-4">
      <div className="flex flex-col gap-2">
        <Card.Heading>{partPlan?.title ?? ""}</Card.Heading>
        {partPlan?.description && <Card.SubHeading>{partPlan.description}</Card.SubHeading>}
      </div>
      <span className="hidden md:inline shrink-0 font-mono text-[11px] tracking-[0.04em] text-foreground/40 tabular-nums">
        <Trans>Feedback</Trans>
      </span>
    </Card.Entry>
  );
}
