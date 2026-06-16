import { Trans } from "@lingui/react/macro";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { parseResponse } from "hono/client";
import { useMemo, useState } from "react";
import { redirect, useLoaderData, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { Pending } from "rxfy-react";
import { map, shareReplay, startWith, tap } from "rxjs";
import type { Route } from "./+types/curriculum.draft.outline";
import type { DraftLoaderData } from "./curriculum.draft";

import { Card } from "~/components/Card";
import { BuilderActionBar } from "~/components/CurriculumBuilder/BuilderActionBar";
import { SelectableCard } from "~/components/CurriculumBuilder/SelectableCard";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { type CurriculumOutline, parseCurriculumOutline } from "~/data/types";
import { useApiClient } from "~/lib/apiClient";
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
  return { hasText: !!draft.textContent };
}

type OutlineState =
  | { status: "streaming"; outline: CurriculumOutline | null }
  | { status: "complete"; outline: CurriculumOutline | null }
  | { status: "error"; message: string };

export default function DraftOutlinePage() {
  const layoutData = useRouteLoaderData<DraftLoaderData>("routes/curriculum.draft");
  const { hasText } = useLoaderData<typeof loader>();
  const { id } = useParams<{ id: string }>();

  const initialOutline = layoutData?.draft.outline ?? null;
  const initialSelectedIds = layoutData?.draft.selections?.selectedPhaseIds ?? [];

  if (!id) return null;

  if (initialOutline) {
    return <OutlineIdleView id={id} outline={initialOutline} initialSelectedIds={initialSelectedIds} />;
  }

  return <OutlineStreamView id={id} hasText={hasText} initialSelectedIds={initialSelectedIds} />;
}

function OutlineIdleView({
  id,
  outline,
  initialSelectedIds,
}: {
  id: string;
  outline: CurriculumOutline;
  initialSelectedIds: string[];
}) {
  const navigate = useNavigate();
  const apiClient = useApiClient();
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedIds);

  function toggle(phaseId: string) {
    setSelectedIds((prev) => (prev.includes(phaseId) ? prev.filter((p) => p !== phaseId) : [...prev, phaseId]));
  }

  async function startGenerating() {
    if (selectedIds.length === 0) return;
    await parseResponse(
      apiClient.api.curriculums.drafts[":id"].$patch({
        param: { id },
        json: { selections: { selectedPhaseIds: selectedIds, deselectedTaskIds: [], currentPhaseIdx: 0 } },
      }),
    );
    const firstPhase = outline.phases.find((p) => selectedIds.includes(p.id));
    if (firstPhase) void navigate(getCurriculumLinks().draft(id).phases(firstPhase.id));
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Card.List>
            <Card.Entry className="flex items-baseline justify-between gap-4">
              <div className="flex flex-col gap-2">
                <Card.Heading>{outline.name || <Trans>Outline</Trans>}</Card.Heading>
                {outline.description && <Card.SubHeading>{outline.description}</Card.SubHeading>}
              </div>
            </Card.Entry>

            {outline.phases.map((phase) => (
              <SelectableCard
                key={phase.id}
                selected={selectedIds.includes(phase.id)}
                onToggle={() => toggle(phase.id)}
                readOnly={false}
                title={phase.title}
                description={phase.subtitle}
              />
            ))}
          </Card.List>
        </ReadingColumn>
      </PageContent>

      <BuilderActionBar>
        <Button className="ml-auto" onClick={() => void startGenerating()} disabled={selectedIds.length === 0}>
          <Trans>Start generating</Trans> <ArrowRightIcon className="inline ml-1" />
        </Button>
      </BuilderActionBar>
    </PageBody>
  );
}

function OutlineStreamView({
  id,
  hasText,
  initialSelectedIds,
}: {
  id: string;
  hasText: boolean;
  initialSelectedIds: string[];
}) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const locale = useLocale();
  const apiClient = useApiClient();
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedIds);

  const stream = useMemo(() => {
    return createLlmStream(async (signal) => {
      if (!hasText) {
        await parseResponse(apiClient.api.curriculums.drafts[":id"].extract.$post({ param: { id } }));
      }
      return apiClient.api.curriculums.drafts[":id"]["generate-outline"].$post(
        { param: { id }, json: { locale } },
        { init: { signal } },
      );
    });
  }, [apiClient, hasText, id, locale]);

  const viewState$ = useMemo(
    () =>
      stream.state$.pipe(
        map((s): OutlineState => {
          if (s.status === "error") {
            return { status: "error", message: getApiErrorMessage(s.error, "Failed to generate outline") };
          }
          let outline: CurriculumOutline | null = null;
          try {
            outline = parseCurriculumOutline(parseJSON<unknown>(s.text)) ?? null;
          } catch {
            // partial stream not yet parseable
          }
          return { status: s.status === "complete" ? "complete" : "streaming", outline };
        }),
        tap((s) => {
          if (s.status !== "complete") return;
          if (s.outline) setSelectedIds(s.outline.phases.map((p) => p.id));
          revalidate();
        }),
        startWith<OutlineState>({ status: "streaming", outline: null }),
        shareReplay({ bufferSize: 1, refCount: false }),
      ),
    [stream, revalidate],
  );

  function toggle(phaseId: string) {
    setSelectedIds((prev) => (prev.includes(phaseId) ? prev.filter((p) => p !== phaseId) : [...prev, phaseId]));
  }

  async function startGenerating(outline: CurriculumOutline | null) {
    if (!outline || selectedIds.length === 0) return;
    await parseResponse(
      apiClient.api.curriculums.drafts[":id"].$patch({
        param: { id },
        json: { selections: { selectedPhaseIds: selectedIds, deselectedTaskIds: [], currentPhaseIdx: 0 } },
      }),
    );
    const firstPhase = outline.phases.find((p) => selectedIds.includes(p.id));
    if (firstPhase) void navigate(getCurriculumLinks().draft(id).phases(firstPhase.id));
  }

  return (
    <PageBody>
      <PageContent>
        <ReadingColumn>
          <Pending value$={viewState$} getDefaultValue={() => ({ status: "streaming", outline: null }) as OutlineState}>
            {(state) => {
              const isStreaming = state.status === "streaming";
              const errorMsg = state.status === "error" ? state.message : null;
              const outline = state.status === "streaming" || state.status === "complete" ? state.outline : null;

              return (
                <>
                  {errorMsg && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{errorMsg}</p>}
                  <Card.List>
                    <Card.Entry className="flex items-baseline justify-between gap-4">
                      <div className="flex flex-col gap-2">
                        <Card.Heading>{outline?.name || <Trans>Generating outline…</Trans>}</Card.Heading>
                        {outline?.description && <Card.SubHeading>{outline.description}</Card.SubHeading>}
                      </div>
                    </Card.Entry>

                    {isStreaming && !outline && (
                      <Card.Entry className="flex items-center gap-2 text-foreground/40">
                        <Spinner />
                        <p className="text-sm">
                          <Trans>Generating outline…</Trans>
                        </p>
                      </Card.Entry>
                    )}

                    {(outline?.phases.length || 0) > 0 &&
                      outline?.phases.map((phase) => (
                        <SelectableCard
                          key={phase.id}
                          selected={selectedIds.includes(phase.id)}
                          onToggle={isStreaming ? undefined : () => toggle(phase.id)}
                          readOnly={isStreaming}
                          title={phase.title}
                          description={phase.subtitle}
                        />
                      ))}
                  </Card.List>
                </>
              );
            }}
          </Pending>
        </ReadingColumn>
      </PageContent>

      <Pending value$={viewState$} getDefaultValue={() => ({ status: "streaming", outline: null }) as OutlineState}>
        {(state) => {
          const isStreaming = state.status === "streaming";
          const outline = state.status === "streaming" || state.status === "complete" ? state.outline : null;

          return (
            <BuilderActionBar>
              <Button
                className="ml-auto"
                onClick={() => void startGenerating(outline)}
                disabled={isStreaming || !outline || selectedIds.length === 0}
              >
                <Trans>Start generating</Trans> <ArrowRightIcon className="inline ml-1" />
              </Button>
            </BuilderActionBar>
          );
        }}
      </Pending>
    </PageBody>
  );
}
