import { I18nProvider } from "@lingui/react";
import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import { useStateData } from "rxfy-react";
import type { Route } from "./+types/root";
import "~/index.css";

import { RateLimitModal } from "~/components/RateLimitModal";
import type { Complexity } from "~/data/types";
import { parseCurriculumDef } from "~/data/types";
import { apiClient } from "~/lib/apiClient";
import { ProgressMutationsContext } from "~/lib/context/progressMutations";
import { activateLocale, getLocaleFromRequest, i18n } from "~/lib/i18n";
import { highestPhase, parseTopicSessionState } from "~/lib/phase";
import { curriculaState } from "~/lib/state/curricula";
import type { ProgressMutations } from "~/lib/state/progress";
import { progressState } from "~/lib/state/progress";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function loader({ request }: Route.LoaderArgs) {
  const locale = getLocaleFromRequest(request);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { locale, user: null, progress: null, onboarding: null, profile: null };

  const userId = session.user.id;
  const [completions, activities, startedAt, topicSessions, customCurriculums, userRecord, profile] = await Promise.all(
    [
      db.taskCompletion.findMany({ where: { userId } }),
      db.dailyActivity.findMany({ where: { userId } }),
      db.appSetting.findUnique({ where: { key_userId: { key: "startedAt", userId } } }),
      db.topicSession.findMany({ where: { userId } }),
      db.customCurriculum.findMany({ where: { userId } }),
      db.user.findUnique({ where: { id: userId }, select: { onboardingSkipped: true } }),
      db.userProfile.findUnique({
        where: { userId },
        select: { markdown: true, updatedAt: true },
      }),
    ],
  );

  return {
    locale,
    user: session.user,
    onboarding: {
      skipped: userRecord?.onboardingSkipped ?? false,
      hasProfile: !!profile && profile.markdown.trim().length > 0,
    },
    profile: profile
      ? {
          markdown: profile.markdown,
          updatedAt: profile.updatedAt.toISOString(),
        }
      : null,
    progress: {
      completedTaskIds: Object.fromEntries(completions.map((t) => [t.taskId, t.completedAt.toISOString()])),
      activity: Object.fromEntries(
        activities.map((a) => [a.date, { date: a.date, taskIds: a.taskIds as string[], minutes: a.minutes }]),
      ),
      startedAt: startedAt?.value ?? new Date().toISOString(),
      activeSessions: Object.fromEntries(
        topicSessions.flatMap((s) => {
          const state = parseTopicSessionState(s.phaseData);
          const top = highestPhase(state);
          if (!top) return [];
          const phase = state.phases[top];
          if (!phase) return [];
          const partIdx = "partIdx" in phase ? phase.partIdx : undefined;
          return [[s.taskId, { name: top, partIdx }]];
        }),
      ),
    },
    customCurriculums: customCurriculums
      .filter((c) => c.status === "published")
      .map((c) =>
        parseCurriculumDef({
          ...c,
          description: c.description ?? undefined,
          cover: c.cover ?? undefined,
          complexity: (c.complexity as Complexity) ?? "deep",
        }),
      )
      .filter((c) => c !== null),
    hasDrafts: customCurriculums.some((c) => c.status === "draft"),
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <Meta />
        <Links />
        {/* Prevent flash of wrong theme before hydration */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.add('dark')}})()`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { locale, progress, customCurriculums } = useLoaderData<typeof loader>();

  if (i18n.locale !== locale) {
    activateLocale(locale);
  }

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const progressDefaultValue = progress
    ? {
        completions: Object.entries(progress.completedTaskIds).map(([taskId, completedAt]) => ({
          taskId,
          completedAt,
        })),
        activity: Object.values(progress.activity),
        activeSessions: Object.entries(progress.activeSessions).map(([taskId, s]) => ({
          taskId,
          ...s,
        })),
      }
    : null;

  const { mutations } = useStateData(
    progressState,
    () => apiClient.api.progress.$get().then((r) => r.json()),
    {},
    progressDefaultValue ? { defaultData: progressDefaultValue } : undefined,
  );

  useStateData(
    curriculaState,
    () => apiClient.api.curriculums.published.$get().then((r) => r.json()),
    {},
    { defaultData: { curricula: customCurriculums ?? [] } },
  );

  return (
    <ProgressMutationsContext value={mutations as unknown as ProgressMutations}>
      <I18nProvider i18n={i18n}>
        <Outlet />
        <RateLimitModal />
      </I18nProvider>
    </ProgressMutationsContext>
  );
}
