import { Trans } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { Link, Outlet, redirect, useLoaderData, useNavigate, useParams, useRouteLoaderData } from "react-router";
import { Pending } from "rxfy-react";
import type { Route } from "./+types/topic-layout";

import { GridBackground } from "~/components/GridBg";
import { ProgramCover } from "~/components/ProgramCover";
import { TopicActionBarSlotContext } from "~/components/TopicActionBar";
import { TopicHeader } from "~/components/TopicHeader";
import { TopicSidebar, type TopicSidebarItem } from "~/components/TopicSidebar";
import { BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator } from "~/components/ui/breadcrumb";
import { listCurriculums } from "~/data/curriculum";
import type { CurriculumDef } from "~/data/types";
import { parseCurriculumDef } from "~/data/types";
import { useProgressData } from "~/hooks/useProgressData";
import { useTopicSession } from "~/hooks/useTopicSession";
import type { BreadcrumbHandle } from "~/lib/breadcrumbs";
import { getLocaleFromRequest } from "~/lib/i18n";
import { highestPhase, parseTopicSessionState, PHASE_ORDER } from "~/lib/phase";
import { getCurriculumLinks } from "~/lib/routes";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";

type PhaseKey = (typeof PHASE_ORDER)[number];

function buildSidebarItems(assessmentSkipped: boolean): TopicSidebarItem[] {
  if (assessmentSkipped) {
    return [
      { path: "study", label: <Trans>Study</Trans> },
      { path: "hands-on", label: <Trans>Practice</Trans> },
      { path: "feedback", label: <Trans>Feedback</Trans> },
      { path: "write-up", label: <Trans>Write-up</Trans> },
      { path: "complete", label: <Trans>Complete</Trans> },
    ];
  }
  return [
    { path: "assess", label: <Trans>Assess</Trans> },
    { path: "gaps", label: <Trans>Gaps</Trans> },
    { path: "study", label: <Trans>Study</Trans> },
    { path: "hands-on", label: <Trans>Practice</Trans> },
    { path: "feedback", label: <Trans>Feedback</Trans> },
    { path: "write-up", label: <Trans>Write-up</Trans> },
    { path: "complete", label: <Trans>Complete</Trans> },
  ];
}

const PHASE_TO_PATH = {
  assessing: "assess",
  "gaps-review": "gaps",
  study: "study",
  "hands-on": "hands-on",
  feedback: "feedback",
  "write-up": "write-up",
} as const satisfies Record<PhaseKey, string>;

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  const title = loaderData?.task?.title;
  return [
    { title: title ? `${title} — Sheafu` : "Topic — Sheafu" },
    {
      name: "description",
      content: title
        ? `Study ${title} with AI-generated material and hands-on practice.`
        : "Study this topic with AI-generated material and hands-on practice.",
    },
  ];
}

function findTask(curriculums: CurriculumDef[], taskId: string) {
  for (const c of curriculums) {
    for (const p of c.phases) {
      for (const t of p.tasks) {
        if (t.id === taskId) {
          return { task: t, curriculumName: c.name, phaseTitle: p.title, complexity: c.complexity, cover: c.cover };
        }
      }
    }
  }
  return null;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const session = await requireSession(request);

  const locale = getLocaleFromRequest(request);
  let taskInfo = findTask(listCurriculums(locale), params.taskId);

  if (!taskInfo) {
    const custom = await db.customCurriculum.findMany({
      where: { userId: session.user.id, status: "published" },
    });
    const customCurriculums = custom
      .map((c) => parseCurriculumDef({ ...c, description: c.description ?? undefined }))
      .filter((c) => c !== null);
    taskInfo = findTask(customCurriculums, params.taskId);
  }

  if (!taskInfo) return redirect(getCurriculumLinks().byId(params.curriculumId));

  const record = await db.topicSession.findUnique({
    where: { userId_taskId: { userId: session.user.id, taskId: params.taskId } },
  });
  const state = record ? parseTopicSessionState(record.phaseData) : { phases: {} };
  const top = highestPhase(state);
  const assessmentSkipped = !state.phases.assessing && !state.phases["gaps-review"];
  const highestPath = top ? PHASE_TO_PATH[top] : null;

  return { ...taskInfo, assessmentSkipped, highestPath };
}

export const handle: BreadcrumbHandle = {
  breadcrumb: () => <TopicBreadcrumb />,
};

function TopicBreadcrumb() {
  const data = useRouteLoaderData<typeof loader>("routes/topic-layout");
  const { curriculumId } = useParams<{ curriculumId: string }>();
  if (!data) return null;
  const { curriculumName, phaseTitle } = data;
  return (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink render={<Link to={curriculumId ? getCurriculumLinks().byId(curriculumId) : "#"} />}>
          {curriculumName}
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem className="text-muted-foreground">
        <span className="truncate">{phaseTitle}</span>
      </BreadcrumbItem>
    </>
  );
}

export default function TopicLayout() {
  const { task, curriculumName, highestPath, cover, assessmentSkipped } = useLoaderData<typeof loader>();
  const { taskId } = useParams<{ curriculumId: string; taskId: string }>();
  const navigate = useNavigate();
  const { deleteSession } = useTopicSession(taskId!);
  const { data$ } = useProgressData();
  const [actionBarSlot, setActionBarSlot] = useState<HTMLElement | null>(null);

  function startOver() {
    void deleteSession();
    void navigate("choice", { relative: "path" });
  }

  const items = useMemo(() => buildSidebarItems(assessmentSkipped), [assessmentSkipped]);
  const highestIdx = highestPath ? items.findIndex((it) => it.path === highestPath) : -1;

  return (
    <TopicActionBarSlotContext value={actionBarSlot}>
      <div className="hidden sm:flex w-full">
        <TopicHeader taskTitle={task.title} curriculumName={curriculumName} onStartOver={startOver} />
      </div>

      <div className="flex flex-col lg:flex-row flex-1">
        <Pending value$={data$}>
          {({ completions }) => {
            const reachedIndex = completions.includes(taskId!) ? items.length - 1 : highestIdx;
            return <TopicSidebar items={items} reachedIndex={reachedIndex} />;
          }}
        </Pending>
        <div className="flex-1 min-w-0 lg:border-l border-border flex flex-col relative">
          {cover && (
            <div className="absolute inset-0">
              <ProgramCover shape="wave" preset={cover} />
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
    </TopicActionBarSlotContext>
  );
}
