import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { useLoaderData, useNavigate, useParams } from "react-router";
import { Pending } from "rxfy-react";
import { filter, map, merge, Observable, of, shareReplay, tap } from "rxjs";
import type { Route } from "./+types/topic.write-up";

import { Card } from "~/components/Card";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { Markdown } from "~/components/Markdown";
import { TopicActionBar } from "~/components/TopicActionBar";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useToggleTask } from "~/hooks/useToggleTask";
import { useTopicSession } from "~/hooks/useTopicSession";
import { useApiClient } from "~/lib/apiClient";
import { createLlmStream, type LlmStream } from "~/lib/llmStream";
import type { Material } from "~/lib/phase";
import { parseTopicSessionState } from "~/lib/phase";
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
  const phase = state.phases["write-up"];
  if (!phase) {
    throw new Response("Not found", { status: 404 });
  }
  return {
    material: phase.material,
    partIdx: phase.partIdx,
    savedFeedback: phase.feedback,
  };
}

type ViewState = {
  feedback: string | null;
  stream: LlmStream | null;
};

export default function WriteUpPage() {
  const { material, partIdx, savedFeedback } = useLoaderData<typeof loader>();
  if (savedFeedback) return <WriteUpCompleteView material={material} partIdx={partIdx} savedFeedback={savedFeedback} />;
  return <WriteUpReflectionView material={material} partIdx={partIdx} />;
}

function WriteUpCompleteView({
  material,
  partIdx,
  savedFeedback,
}: {
  material: Material;
  partIdx: number;
  savedFeedback: string;
}) {
  const { curriculumId, taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  const { deleteSession } = useTopicSession(taskId!);
  const toggleTask = useToggleTask();

  const part = material.parts[partIdx]!;

  async function handleComplete() {
    if (taskId) await toggleTask(taskId);
    void deleteSession();
    void navigate(getTopicLinks(curriculumId!, taskId!).complete);
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <WriteUpHeading part={part} />
            <Card.Entry className="gap-2">
              <Card.Heading>
                <Trans>Tutor feedback</Trans>
              </Card.Heading>
              <Markdown>{savedFeedback}</Markdown>
            </Card.Entry>
          </Card.List>
        </ReadingColumn>
      </PageContent>
      <TopicActionBar>
        <Button className="ml-auto" disabled>
          <Trans>Submit reflection</Trans>
        </Button>
        <Button onClick={() => void handleComplete()}>
          <Trans>Complete</Trans>
        </Button>
      </TopicActionBar>
    </PageBody>
  );
}

function WriteUpReflectionView({ material, partIdx }: { material: Material; partIdx: number }) {
  const { curriculumId, taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  const { saveSession, deleteSession } = useTopicSession(taskId!);
  const toggleTask = useToggleTask();
  const { t } = useLingui();
  const locale = useLocale();
  const apiClient = useApiClient();

  const part = material.parts[partIdx]!;

  const [text, setText] = useState("");
  const [stream, setStream] = useState<LlmStream | null>(null);

  const viewState$ = useMemo<Observable<ViewState>>(() => {
    if (!stream) return of({ feedback: null, stream: null });
    const terminal$ = stream.state$.pipe(
      filter((s) => s.status === "complete" || s.status === "error"),
      map((s) => (s.status === "complete" ? { feedback: s.text, stream: null } : { feedback: null, stream })),
      tap((vs) => {
        if (vs.feedback !== null) {
          void saveSession({ name: "write-up", material, partIdx, feedback: vs.feedback });
        }
      }),
    );
    return merge(of<ViewState>({ feedback: null, stream }), terminal$).pipe(
      shareReplay({ bufferSize: 1, refCount: false }),
    );
  }, [stream, saveSession, material, partIdx]);

  function handleSubmit() {
    setStream(
      createLlmStream((signal) =>
        apiClient.api.llm["write-up-feedback"].$post(
          { json: { topic: part.title, reflection: text, locale } },
          { init: { signal } },
        ),
      ),
    );
  }

  async function handleComplete() {
    if (taskId) await toggleTask(taskId);
    void deleteSession();
    void navigate(getTopicLinks(curriculumId!, taskId!).complete);
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <WriteUpHeading part={part} />

            <Pending value$={viewState$} getDefaultValue={() => ({ feedback: null, stream: null })}>
              {({ feedback, stream: activeStream }) => (
                <>
                  <Card.Entry>
                    <Textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={t`Write your reflection in your own words…`}
                      rows={4}
                      aria-label={t`Text input`}
                      disabled={!!activeStream || !!feedback}
                    />
                  </Card.Entry>

                  {activeStream && (
                    <Pending value$={activeStream.state$}>
                      {(state) => {
                        if (state.status === "error") {
                          return (
                            <Card.Entry className="flex flex-row items-center gap-2 text-destructive">
                              <p className="text-sm">
                                <Trans>Failed to generate feedback.</Trans>
                              </p>
                              <Button variant="secondary" size="sm" onClick={() => activeStream.retry()}>
                                <Trans>Retry</Trans>
                              </Button>
                            </Card.Entry>
                          );
                        }
                        return (
                          <Card.Entry className="gap-2">
                            <Card.Heading className="flex items-center gap-2">
                              {state.status === "streaming" && <Spinner />}
                              <Trans>Tutor feedback</Trans>
                            </Card.Heading>
                            <Markdown isAnimating={state.status === "streaming"}>{state.text}</Markdown>
                          </Card.Entry>
                        );
                      }}
                    </Pending>
                  )}

                  {!activeStream && feedback && (
                    <Card.Entry className="gap-2">
                      <Card.Heading>
                        <Trans>Tutor feedback</Trans>
                      </Card.Heading>
                      <Markdown>{feedback}</Markdown>
                    </Card.Entry>
                  )}
                </>
              )}
            </Pending>
          </Card.List>
        </ReadingColumn>
      </PageContent>

      <Pending value$={viewState$} getDefaultValue={() => ({ feedback: null, stream: null })}>
        {({ feedback, stream: activeStream }) => (
          <TopicActionBar>
            <Button className="ml-auto" onClick={() => handleSubmit()} disabled={!!activeStream || !!feedback}>
              <Trans>Submit reflection</Trans>
            </Button>
            <Button onClick={() => void handleComplete()} disabled={!!activeStream || !feedback}>
              <Trans>Complete</Trans>
            </Button>
          </TopicActionBar>
        )}
      </Pending>
    </PageBody>
  );
}

function WriteUpHeading({ part }: { part: { writeUpPrompt: string } }) {
  return (
    <Card.Entry>
      <div className="flex flex-col gap-2">
        <Card.Heading>
          <Trans>Reflect</Trans>
        </Card.Heading>
        <Card.SubHeading>{part.writeUpPrompt}</Card.SubHeading>
      </div>
    </Card.Entry>
  );
}
