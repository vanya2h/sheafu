import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { useLoaderData, useNavigate, useParams } from "react-router";
import { Pending } from "rxfy-react";
import type { Route } from "./+types/topic.hands-on";

import { Card } from "~/components/Card";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { Markdown } from "~/components/Markdown";
import { TopicActionBar } from "~/components/TopicActionBar";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useTopicSession } from "~/hooks/useTopicSession";
import { apiClient } from "~/lib/apiClient";
import { createLlmStream, type LlmStream } from "~/lib/llmStream";
import { isPhaseReadOnly, parseTopicSessionState } from "~/lib/phase";
import { getTopicLinks } from "~/lib/routes";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";
import { useLocale } from "~app/hooks/useLocale";

export async function loader({ request, params }: Route.LoaderArgs) {
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
  const readOnly = isPhaseReadOnly(state, "hands-on");

  const handsOn = state.phases["hands-on"];
  if (handsOn) {
    return { material: handsOn.material, partIdx: handsOn.partIdx, savedAnswers: handsOn.answers, readOnly };
  }
  const study = state.phases.study;
  if (study) {
    return { material: study.material, partIdx: study.partIdx, savedAnswers: {} as Record<string, string>, readOnly };
  }
  throw new Response("Not found", { status: 404 });
}

export default function HandsOnPage() {
  const { material, partIdx, savedAnswers, readOnly } = useLoaderData<typeof loader>();
  const { curriculumId, taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  const { saveSession } = useTopicSession(taskId!);
  const { t } = useLingui();
  const locale = useLocale();

  const [answers, setAnswers] = useState<Record<string, string>>(savedAnswers);
  const [streams, setStreams] = useState<Record<number, LlmStream>>({});
  const [solutionShown, setSolutionShown] = useState<Record<number, boolean>>({});
  const [hintShown, setHintShown] = useState<Record<number, boolean>>({});

  const { parts } = material;
  const part = parts[partIdx]!;
  const allAnswered = part.handsOn.every((_, i) => (answers[i] ?? "").trim().length > 0);

  function handleSolution(idx: number, task: string, hint?: string) {
    setSolutionShown((prev) => ({ ...prev, [idx]: true }));
    setStreams((prev) => ({
      ...prev,
      [idx]: createLlmStream((signal) =>
        apiClient.api.llm["task-solution"].$post({ json: { task, hint, locale } }, { init: { signal } }),
      ),
    }));
  }

  async function handleSubmit() {
    await saveSession({ name: "hands-on", material, partIdx, answers });
    void navigate(getTopicLinks(curriculumId!, taskId!).feedback);
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn className="flex flex-col gap-8">
          {part.handsOn.map((taskItem, i) => (
            <Card.List key={i}>
              <Card.Entry>
                <Card.Heading>
                  <Trans>Task {i + 1}</Trans>
                </Card.Heading>
              </Card.Entry>
              <Card.Entry>
                <Markdown>{taskItem.task}</Markdown>
              </Card.Entry>

              <Card.Entry>
                <Textarea
                  value={answers[i] ?? ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                  placeholder={t`Your answer, code, or reasoning…`}
                  rows={4}
                  aria-label={t`Text input`}
                  disabled={readOnly}
                />
              </Card.Entry>

              <Card.Entry className="flex flex-row flex-wrap items-center gap-2">
                {taskItem.hint && (
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setHintShown((prev) => ({ ...prev, [i]: !prev[i] }))}
                  >
                    {hintShown[i] ? <Trans>Hide hint</Trans> : <Trans>Show hint</Trans>}
                  </Button>
                )}
                {streams[i] ? (
                  <Pending value$={streams[i].state$}>
                    {(state) => (
                      <>
                        {solutionShown[i] && state.status !== "streaming" ? (
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => setSolutionShown((p) => ({ ...p, [i]: false }))}
                          >
                            <Trans>Hide solution</Trans>
                          </Button>
                        ) : (
                          <Button
                            size="xs"
                            disabled={state.status === "streaming"}
                            onClick={() => setSolutionShown((p) => ({ ...p, [i]: true }))}
                          >
                            <Trans>See solution</Trans>
                          </Button>
                        )}
                        {state.status === "streaming" && <Spinner />}
                      </>
                    )}
                  </Pending>
                ) : (
                  <Button size="xs" onClick={() => handleSolution(i, taskItem.task, taskItem.hint)}>
                    <Trans>See solution</Trans>
                  </Button>
                )}
              </Card.Entry>

              {taskItem.hint && hintShown[i] && (
                <Card.Entry className="gap-2">
                  <Card.Heading>
                    <Trans>Hint</Trans>
                  </Card.Heading>
                  <Card.SubHeading>{taskItem.hint}</Card.SubHeading>
                </Card.Entry>
              )}

              {streams[i] && solutionShown[i] && (
                <Pending value$={streams[i].state$}>
                  {(state) => {
                    if (state.status === "error") {
                      return (
                        <Card.Entry className="gap-2">
                          <Card.Heading>
                            <Trans>Solution</Trans>
                          </Card.Heading>
                          <p className="text-sm text-destructive">
                            <Trans>Failed to generate solution.</Trans>
                          </p>
                        </Card.Entry>
                      );
                    }
                    if (!state.text) return null;
                    return (
                      <Card.Entry className="gap-2">
                        <Card.Heading>
                          <Trans>Solution</Trans>
                        </Card.Heading>
                        <Markdown isAnimating={state.status === "streaming"}>{state.text}</Markdown>
                      </Card.Entry>
                    );
                  }}
                </Pending>
              )}
            </Card.List>
          ))}
        </ReadingColumn>
      </PageContent>

      {!readOnly && (
        <TopicActionBar>
          <Button className="ml-auto" disabled={!allAnswered} onClick={() => void handleSubmit()}>
            <Trans>Submit for feedback</Trans>
          </Button>
        </TopicActionBar>
      )}
    </PageBody>
  );
}
