import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { useLoaderData, useNavigate, useParams, useRouteLoaderData } from "react-router";
import { Pending } from "rxfy-react";
import { shareReplay, tap } from "rxjs";
import type { Route } from "./+types/topic.assess";
import type { loader as layoutLoader } from "./topic-layout";

import { Card } from "~/components/Card";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { TopicActionBar } from "~/components/TopicActionBar";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useTopicSession } from "~/hooks/useTopicSession";
import { useApiClient } from "~/lib/apiClient";
import { parseJSON } from "~/lib/json";
import { createLlmStream, type LlmStream } from "~/lib/llmStream";
import { isPhaseReadOnly, parseTopicSessionState } from "~/lib/phase";
import { getTopicLinks } from "~/lib/routes";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";
import { useLocale } from "~app/hooks/useLocale";

export async function loader({ request, params }: Route.LoaderArgs) {
  const session = await requireSession(request);
  const record = await db.topicSession.findUnique({
    where: { userId_taskId: { userId: session.user.id, taskId: params.taskId } },
  });
  const state = record ? parseTopicSessionState(record.phaseData) : { phases: {} };
  const phase = state.phases.assessing;
  const readOnly = isPhaseReadOnly(state, "assessing");
  if (phase) {
    return { questions: phase.questions, answers: phase.answers, readOnly };
  }
  return { questions: null, answers: {} as Record<string, string>, readOnly: false };
}

type AssessPhase = { phase: "generating"; stream: LlmStream } | { phase: "questions"; questions: string[] };

export default function AssessPage() {
  const loaderData = useLoaderData<typeof loader>();
  const layoutData = useRouteLoaderData<typeof layoutLoader>("routes/topic-layout");
  if (!layoutData?.task) return null;
  return <AssessContent loaderData={loaderData} layoutData={layoutData} />;
}

function AssessContent({
  loaderData,
  layoutData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  layoutData: Extract<Awaited<ReturnType<typeof layoutLoader>>, { task: unknown }>;
}) {
  const { curriculumId, taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  const { saveSession } = useTopicSession(taskId!);
  const locale = useLocale();
  const apiClient = useApiClient();

  const { task, curriculumName, complexity } = layoutData;

  const [phase, setPhase] = useState<AssessPhase>(() =>
    loaderData.questions
      ? { phase: "questions", questions: loaderData.questions }
      : {
          phase: "generating",
          stream: createLlmStream((signal) =>
            apiClient.api.llm.assessment.$post(
              { json: { topic: task.title, curriculum: curriculumName ?? "", complexity, locale } },
              { init: { signal } },
            ),
          ),
        },
  );
  const [answers, setAnswers] = useState<Record<string, string>>(loaderData.answers);

  function startStream() {
    setAnswers({});
    setPhase({
      phase: "generating",
      stream: createLlmStream((signal) =>
        apiClient.api.llm.assessment.$post(
          { json: { topic: task.title, curriculum: curriculumName ?? "", complexity, locale } },
          { init: { signal } },
        ),
      ),
    });
  }

  function handleQuestionsReady(qs: string[]) {
    setPhase({ phase: "questions", questions: qs });
    void saveSession({ name: "assessing", questions: qs, answers: {} });
  }

  function handleAnswerChange(idx: number, value: string) {
    setAnswers((prev) => ({ ...prev, [idx]: value }));
  }

  async function handleSubmit(questions: string[]) {
    await saveSession({ name: "assessing", questions, answers });
    void navigate(getTopicLinks(curriculumId!, taskId!).gaps);
  }

  if (phase.phase === "questions") {
    return (
      <AssessQuestionsView
        questions={phase.questions}
        answers={answers}
        readOnly={loaderData.readOnly}
        onAnswerChange={handleAnswerChange}
        onRegenerate={startStream}
        onSubmit={() => void handleSubmit(phase.questions)}
      />
    );
  }
  return (
    <AssessGeneratingView
      stream={phase.stream}
      readOnly={loaderData.readOnly}
      onComplete={handleQuestionsReady}
      onRegenerate={startStream}
    />
  );
}

function AssessGeneratingView({
  stream,
  readOnly,
  onComplete,
  onRegenerate,
}: {
  stream: LlmStream;
  readOnly: boolean;
  onComplete: (questions: string[]) => void;
  onRegenerate: () => void;
}) {
  const streamState$ = useMemo(
    () =>
      stream.state$.pipe(
        tap((state) => {
          if (state.status !== "complete") return;
          try {
            const { questions: qs } = parseJSON<{ questions: string[] }>(state.text);
            onComplete(qs);
          } catch {
            // malformed LLM response
          }
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      ),
    [stream, onComplete],
  );

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <AssessHeading readOnly={readOnly} onRegenerate={onRegenerate} disableRegenerate />
            <Pending value$={streamState$}>
              {(state) => {
                if (state.status === "error") {
                  return (
                    <Card.Entry className="flex flex-row items-center gap-2 text-destructive">
                      <p className="text-sm">
                        <Trans>Failed to generate questions.</Trans>
                      </p>
                      <Button variant="secondary" size="sm" onClick={() => stream.retry()}>
                        <Trans>Retry</Trans>
                      </Button>
                    </Card.Entry>
                  );
                }
                const partialQs = tryParseQuestions(state.text);
                return (
                  <>
                    <Card.Entry className="flex flex-row items-center gap-2 text-foreground/40">
                      <Spinner />
                      <p className="text-sm">
                        <Trans>Preparing assessment questions…</Trans>
                      </p>
                    </Card.Entry>
                    {partialQs.map((q, i) => (
                      <Card.Entry key={i} className="text-sm text-foreground">
                        {i + 1}. {q}
                      </Card.Entry>
                    ))}
                  </>
                );
              }}
            </Pending>
          </Card.List>
        </ReadingColumn>
      </PageContent>
    </PageBody>
  );
}

function AssessQuestionsView({
  questions,
  answers,
  readOnly,
  onAnswerChange,
  onRegenerate,
  onSubmit,
}: {
  questions: string[];
  answers: Record<string, string>;
  readOnly: boolean;
  onAnswerChange: (idx: number, value: string) => void;
  onRegenerate: () => void;
  onSubmit: () => void;
}) {
  const { t } = useLingui();
  const allAnswered = questions.every((_, i) => (answers[i] ?? "").trim().length > 0);

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <AssessHeading readOnly={readOnly} onRegenerate={onRegenerate} />
            {questions.map((q, i) => (
              <Card.Entry className="gap-4" key={i}>
                <p className="text-sm font-medium text-foreground">
                  {i + 1}. {q}
                </p>
                <Textarea
                  value={answers[i] ?? ""}
                  onChange={(e) => onAnswerChange(i, e.target.value)}
                  placeholder={t`Your answer…`}
                  rows={3}
                  aria-label={t`Text input`}
                  disabled={readOnly}
                />
              </Card.Entry>
            ))}
          </Card.List>
        </ReadingColumn>
      </PageContent>

      {!readOnly && (
        <TopicActionBar>
          <Button className="ml-auto" disabled={!allAnswered} onClick={onSubmit}>
            <Trans>Submit answers</Trans>
          </Button>
        </TopicActionBar>
      )}
    </PageBody>
  );
}

function AssessHeading({
  readOnly,
  onRegenerate,
  disableRegenerate = false,
}: {
  readOnly: boolean;
  onRegenerate: () => void;
  disableRegenerate?: boolean;
}) {
  return (
    <Card.Entry className="flex items-baseline justify-between gap-4">
      <div className="flex flex-col gap-2">
        <Card.Heading>
          <Trans>Quick Assessment</Trans>
        </Card.Heading>
        <Card.SubHeading>
          <Trans>Answer each question in 2–4 sentences. Honest answers get more useful material.</Trans>
        </Card.SubHeading>
      </div>
      {!readOnly && (
        <Button variant="secondary" size="sm" onClick={onRegenerate} disabled={disableRegenerate}>
          <Trans>Regenerate</Trans>
        </Button>
      )}
    </Card.Entry>
  );
}

function tryParseQuestions(text: string): string[] {
  try {
    const { questions: qs } = parseJSON<{ questions?: string[] }>(text);
    if (Array.isArray(qs)) return qs.filter((q): q is string => typeof q === "string");
    return [];
  } catch {
    return [];
  }
}
