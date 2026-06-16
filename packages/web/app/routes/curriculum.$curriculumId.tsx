import { Trans } from "@lingui/react/macro";
import { isRouteErrorResponse, Link, useParams } from "react-router";
import { Pending, useModelStore } from "rxfy-react";
import type { Route } from "./+types/curriculum.$curriculumId";

import { CurriculumView } from "~/components/CurriculumView";
import { BreadcrumbItem, BreadcrumbPage } from "~/components/ui/breadcrumb";
import { Button } from "~/components/ui/button";
import { getCurriculum } from "~/data/curriculum";
import { useCurriculaData } from "~/hooks/useCurriculaData";
import type { BreadcrumbHandle } from "~/lib/breadcrumbs";
import { getLocaleFromRequest } from "~/lib/i18n";
import { CustomCurriculumModel } from "~/lib/models/curriculum";
import { getHomeRoute } from "~/lib/routes";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { useLocale } from "~app/hooks/useLocale";

export function meta({ data }: Route.MetaArgs): Route.MetaDescriptors {
  const name = data?.curriculumName;
  return [
    { title: name ? `${name} — Sheafu` : "Curriculum — Sheafu" },
    {
      name: "description",
      content: name
        ? `Explore topics and track your progress in ${name}.`
        : "Explore curriculum topics and track your learning progress.",
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const locale = getLocaleFromRequest(request);
  const staticCurriculum = getCurriculum(params.curriculumId, locale);
  if (staticCurriculum) return { curriculumName: staticCurriculum.name };

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new Response(null, { status: 404 });

  const custom = await db.customCurriculum.findFirst({
    where: { id: params.curriculumId, userId: session.user.id },
    select: { name: true },
  });
  if (!custom) throw new Response(null, { status: 404 });
  return { curriculumName: custom.name };
}

export const handle: BreadcrumbHandle = {
  breadcrumb: () => <CurriculumBreadcrumb />,
};

export default function CurriculumPage() {
  return <CurriculumView />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const isNotFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="flex grow flex-col items-center justify-center px-4 sm:px-6 lg:px-8 py-32 text-center">
      <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-foreground/40">
        {isNotFound ? "404" : "Error"}
      </div>
      <h1 className="mt-4 text-4xl font-semibold tracking-[-0.02em] text-foreground">
        {isNotFound ? <Trans>Curriculum not found</Trans> : <Trans>Something went wrong</Trans>}
      </h1>
      <p className="mt-3 max-w-md text-muted-foreground">
        {isNotFound ? (
          <Trans>
            This program doesn&apos;t exist or you don&apos;t have access. Browse available programs from the home page.
          </Trans>
        ) : (
          <Trans>An unexpected error occurred. Please try again.</Trans>
        )}
      </p>
      <Button size="lg" render={<Link to={getHomeRoute()} />} className="mt-8">
        <Trans>Back to home</Trans>
      </Button>
    </main>
  );
}

function CurriculumBreadcrumb() {
  const { curriculumId } = useParams<{ curriculumId: string }>();
  const locale = useLocale();
  const { data$: curricula$ } = useCurriculaData();
  const customStore = useModelStore(CustomCurriculumModel);

  if (!curriculumId) return null;

  const builtIn = getCurriculum(curriculumId, locale);
  if (builtIn) {
    return (
      <BreadcrumbItem>
        <BreadcrumbPage>{builtIn.name}</BreadcrumbPage>
      </BreadcrumbItem>
    );
  }

  return (
    <Pending value$={curricula$}>
      {() => {
        const name = customStore.getValue(curriculumId)?.name ?? "";
        return (
          <BreadcrumbItem>
            <BreadcrumbPage>{name}</BreadcrumbPage>
          </BreadcrumbItem>
        );
      }}
    </Pending>
  );
}
