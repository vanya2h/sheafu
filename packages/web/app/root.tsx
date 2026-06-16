import { I18nProvider } from "@lingui/react";
import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import type { Route } from "./+types/root";
import "~/index.css";

import { RateLimitModal } from "~/components/RateLimitModal";
import { useCurriculaData } from "~/hooks/useCurriculaData";
import { useProgressData } from "~/hooks/useProgressData";
import { activateLocale, getLocaleFromRequest, i18n } from "~/lib/i18n";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function loader({ request }: Route.LoaderArgs) {
  const locale = getLocaleFromRequest(request);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      locale,
      user: null,
      onboarding: null,
      hasDrafts: false,
    };
  }

  const userId = session.user.id;
  const [customCurriculums, userRecord, profile] = await Promise.all([
    db.customCurriculum.findMany({ where: { userId }, select: { status: true } }),
    db.user.findUnique({ where: { id: userId }, select: { onboardingSkipped: true } }),
    db.userProfile.findUnique({ where: { userId }, select: { markdown: true } }),
  ]);

  return {
    locale,
    user: session.user,
    onboarding: {
      skipped: userRecord?.onboardingSkipped ?? false,
      hasProfile: !!profile && profile.markdown.trim().length > 0,
    },
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
  const { locale } = useLoaderData<typeof loader>();

  useProgressData();
  useCurriculaData();

  if (i18n.locale !== locale) {
    activateLocale(locale);
  }

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <I18nProvider i18n={i18n}>
      <Outlet />
      <RateLimitModal />
    </I18nProvider>
  );
}
