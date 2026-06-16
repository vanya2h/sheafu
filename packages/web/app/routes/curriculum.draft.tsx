import { Trans } from "@lingui/react/macro";
import { parseResponse } from "hono/client";
import { useState } from "react";
import { Outlet, redirect, useLoaderData, useNavigate, useParams, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/curriculum.draft";

import { BuilderActionBarSlotContext } from "~/components/CurriculumBuilder/BuilderActionBar";
import { BuilderSidebar, type DraftStep } from "~/components/CurriculumBuilder/BuilderSidebar";
import { GridBackground } from "~/components/GridBg";
import { Inset } from "~/components/layout/Inset";
import { ProgramCover } from "~/components/ProgramCover";
import { BreadcrumbItem, BreadcrumbPage } from "~/components/ui/breadcrumb";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { type CurriculumOutline, parseCurriculumOutline } from "~/data/types";
import { useApiClient } from "~/lib/apiClient";
import type { BreadcrumbHandle } from "~/lib/breadcrumbs";
import { type GradientCover, GradientCoverSchema } from "~/lib/gradient";
import { getCurriculumLinks } from "~/lib/routes";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";

export type DraftLoaderData = {
  draft: {
    id: string;
    name: string;
    description: string | null;
    complexity: string;
    cover: GradientCover | null;
    jobUrl: string | null;
    textContent: string | null;
    outline: CurriculumOutline | null;
    generatedPhases: Record<string, unknown>;
    selections: { selectedPhaseIds: string[]; deselectedTaskIds: string[]; currentPhaseIdx: number } | null;
  };
  reachedStep: DraftStep;
  firstPhaseId: string | undefined;
};

export async function loader({ request, params }: Route.LoaderArgs): Promise<DraftLoaderData> {
  const session = await requireSession(request);
  const draft = await db.customCurriculum.findFirst({
    where: { id: params.id, userId: session.user.id },
  });
  const links = getCurriculumLinks();
  if (!draft) throw redirect(links.new);

  const url = new URL(request.url);
  const onFinish = url.pathname.endsWith("/finish");

  if (draft.status === "published" && !onFinish) {
    throw redirect(links.byId(draft.id));
  }

  const outline = parseCurriculumOutline(draft.outline);
  const generatedPhases = (draft.generatedPhases ?? {}) as Record<string, unknown>;
  const cover = GradientCoverSchema.safeParse(draft.cover).data ?? null;

  const selectionsParse = parseSelections(draft.selections);
  const reachedStep = computeReachedStep({
    status: draft.status,
    outline,
    generatedPhases,
    selectedPhaseIds: selectionsParse?.selectedPhaseIds ?? [],
  });
  const firstPhaseId = outline?.phases.find((p) => (selectionsParse?.selectedPhaseIds ?? []).includes(p.id))?.id;

  return {
    draft: {
      id: draft.id,
      name: draft.name,
      description: draft.description,
      complexity: draft.complexity,
      cover,
      jobUrl: draft.jobUrl,
      textContent: draft.textContent,
      outline,
      generatedPhases,
      selections: selectionsParse,
    },
    reachedStep,
    firstPhaseId,
  };
}

function parseSelections(value: unknown): DraftLoaderData["draft"]["selections"] {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.selectedPhaseIds) || !Array.isArray(v.deselectedTaskIds)) return null;
  return {
    selectedPhaseIds: v.selectedPhaseIds.filter((s): s is string => typeof s === "string"),
    deselectedTaskIds: v.deselectedTaskIds.filter((s): s is string => typeof s === "string"),
    currentPhaseIdx: typeof v.currentPhaseIdx === "number" ? v.currentPhaseIdx : 0,
  };
}

function computeReachedStep(args: {
  status: string;
  outline: CurriculumOutline | null;
  generatedPhases: Record<string, unknown>;
  selectedPhaseIds: string[];
}): DraftStep {
  if (args.status === "published") return "finish";
  if (!args.outline) return "outline";
  const allGenerated =
    args.selectedPhaseIds.length > 0 && args.selectedPhaseIds.every((id) => args.generatedPhases[id]);
  if (allGenerated) return "finish";
  if (Object.keys(args.generatedPhases).length > 0) return "phases";
  return "outline";
}

export const handle: BreadcrumbHandle = {
  breadcrumb: () => <DraftBreadcrumb />,
};

function DraftBreadcrumb() {
  const data = useRouteLoaderData<typeof loader>("routes/curriculum.draft");
  if (!data) return null;
  return (
    <BreadcrumbItem>
      <BreadcrumbPage>{data.draft.name ? data.draft.name : <Trans>New program</Trans>}</BreadcrumbPage>
    </BreadcrumbItem>
  );
}

export default function DraftLayout() {
  const data = useLoaderData<typeof loader>();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const apiClient = useApiClient();
  const [actionBarSlot, setActionBarSlot] = useState<HTMLElement | null>(null);

  async function discardDraft() {
    if (!id) return;
    await parseResponse(apiClient.api.curriculums.drafts[":id"].$delete({ param: { id } }));
    void navigate(getCurriculumLinks().new);
  }

  return (
    <BuilderActionBarSlotContext value={actionBarSlot}>
      <DraftHeader title={data.draft.name || "New program"} onDiscard={() => void discardDraft()} />
      <div className="flex flex-col lg:flex-row flex-1">
        <BuilderSidebar reachedStep={data.reachedStep} firstPhaseId={data.firstPhaseId} />
        <div className="flex-1 min-w-0 lg:border-l border-border flex flex-col relative">
          {data.draft.cover && (
            <div className="absolute inset-0">
              <ProgramCover shape="wave" preset={data.draft.cover} />
            </div>
          )}
          <div className="relative grow flex flex-col">
            <GridBackground />
            <div className="flex-1 flex flex-col">
              <Outlet />
            </div>
            <div ref={setActionBarSlot} className="sticky bottom-0 z-10 shrink-0" />
          </div>
        </div>
      </div>
    </BuilderActionBarSlotContext>
  );
}

function DraftHeader({ title, onDiscard }: { title: string; onDiscard: () => void }) {
  return (
    <Inset as="header" className="hidden md:flex items-center gap-4 py-3 sm:py-4 border-b border-border bg-background">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-foreground truncate">{title}</h1>
        <p className="text-xs text-muted-foreground truncate">
          <Trans>Draft</Trans>
        </p>
      </div>
      <div className="ml-auto shrink-0">
        <Dialog>
          <DialogTrigger render={<Button type="button" variant="secondary" />}>
            <Trans>Discard</Trans>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>
              <Trans>Discard this draft?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>The draft and any generated content will be permanently deleted.</Trans>
            </DialogDescription>
            <div className="mt-6 flex justify-end gap-2">
              <DialogClose render={<Button variant="ghost" />}>
                <Trans>Cancel</Trans>
              </DialogClose>
              <DialogClose render={<Button variant="destructive" />} onClick={onDiscard}>
                <Trans>Discard</Trans>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </Inset>
  );
}
