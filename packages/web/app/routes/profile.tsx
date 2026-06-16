import { Trans, useLingui } from "@lingui/react/macro";
import {
  ArrowRightIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckIcon,
  DotsThreeVerticalIcon,
  FileTextIcon,
  PencilSimpleIcon,
  TrashIcon,
  UploadIcon,
} from "@phosphor-icons/react";
import type { UserProfile } from "@prisma/client-generated";
import { DetailedError, parseResponse } from "hono/client";
import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/profile";

import { Card } from "~/components/Card";
import { DashedBorder } from "~/components/DashedBorder";
import { GridBackground } from "~/components/GridBg";
import { PageBody } from "~/components/layout/PageBody";
import { PageContent } from "~/components/layout/PageContent";
import { ReadingColumn } from "~/components/layout/ReadingColumn";
import { Markdown } from "~/components/Markdown";
import { ProgramCover } from "~/components/ProgramCover";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useTheme } from "~/hooks/useTheme";
import { useApiClient } from "~/lib/apiClient";
import { GRADIENT_PRESETS } from "~/lib/gradient";
import { getHomeRoute } from "~/lib/routes";
import { cn } from "~/lib/utils";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { requireSession } from "~/server/session";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Profile — Sheafu" }, { name: "description", content: "Your CV-derived learning profile." }];
}

function extractErrorMessage(err: unknown): string | null {
  if (!(err instanceof DetailedError)) return null;
  const data = err.detail?.data as { error?: unknown } | undefined;
  return typeof data?.error === "string" ? data.error : null;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireSession(request);
  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session!.user.id;

  const profile = await db.userProfile.findUnique({
    where: { userId },
    select: { markdown: true, updatedAt: true },
  });

  return {
    user: { name: session!.user.name },
    profile: profile
      ? {
          markdown: profile.markdown,
          updatedAt: profile.updatedAt.toISOString(),
        }
      : null,
  };
}

export default function ProfilePage({ loaderData }: Route.ComponentProps) {
  const { user, profile } = loaderData;
  const { theme } = useTheme();

  return (
    <PageBody className="relative">
      <div className="absolute inset-0">
        <ProgramCover shape="wave" preset={theme === "dark" ? GRADIENT_PRESETS.heroDark : GRADIENT_PRESETS.heroLight} />
      </div>
      <GridBackground />
      <PageContent className="relative items-center justify-center">
        <ReadingColumn>{profile ? <FilledState profile={profile} /> : <EmptyState user={user} />}</ReadingColumn>
      </PageContent>
    </PageBody>
  );
}

function EmptyState({ user }: { user: { name: string } }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const apiClient = useApiClient();
  const { t } = useLingui();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (file.type !== "application/pdf") {
      setError(t`Please upload a PDF.`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      await parseResponse(apiClient.api.profile.upload.$post({ form: { file } }));
      void revalidator.revalidate();
    } catch (err) {
      setError(extractErrorMessage(err) ?? t`Something went wrong. Please try again.`);
    } finally {
      setUploading(false);
    }
  }

  async function handleSkip() {
    try {
      await parseResponse(apiClient.api.profile["skip-onboarding"].$post());
      navigate(getHomeRoute());
    } catch {
      navigate(getHomeRoute());
    }
  }

  return (
    <Card.List className="my-auto">
      <Card.Entry className="gap-2">
        <Card.Heading>
          <Trans>Hello, {user.name}</Trans>
        </Card.Heading>
        <Card.SubHeading>
          <Trans>
            Upload your CV so we can tailor every curriculum, assessment, and explanation to what you already know — and
            what you actually want to do next.
          </Trans>
        </Card.SubHeading>
      </Card.Entry>
      <Card.Entry>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void handleFile(file);
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "relative flex min-h-32 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl bg-muted/20 p-6 text-center transition-colors hover:bg-muted/40",
            dragOver && "border-foreground/40 bg-muted/60",
            uploading && "pointer-events-none opacity-80",
          )}
        >
          <DashedBorder />
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />
          {uploading ? (
            <>
              <Spinner />
              <p className="text-sm text-muted-foreground">
                <Trans>Reading your CV and extracting your profile…</Trans>
              </p>
            </>
          ) : (
            <>
              <UploadIcon size={28} className="text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  <Trans>Drop your CV here, or click to browse</Trans>
                </p>
                <p className="text-xs text-muted-foreground">
                  <Trans>PDF only · max 10 pages of text</Trans>
                </p>
              </div>
            </>
          )}
        </div>
      </Card.Entry>

      {error && (
        <Card.Entry>
          <p className="text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 rounded-lg">
            {error}
          </p>
        </Card.Entry>
      )}

      <Card.Entry className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-xs text-muted-foreground">
          <Trans>
            Your CV is sent to Anthropic to extract a profile. We don&apos;t store the PDF or its raw text — only the
            structured profile shown below.
          </Trans>
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleSkip()}
          disabled={uploading}
          className="w-full sm:w-auto sm:shrink-0"
        >
          <Trans>Skip for now</Trans>
        </Button>
      </Card.Entry>
    </Card.List>
  );
}

type Profile = Pick<UserProfile, "markdown"> & { updatedAt: string };

function FilledState({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const apiClient = useApiClient();
  const { t } = useLingui();
  const [markdown, setMarkdown] = useState(profile.markdown);
  const [savingMarkdown, setSavingMarkdown] = useState(false);
  const [reuploadOpen, setReuploadOpen] = useState(false);
  const [reuploading, setReuploading] = useState(false);
  const [reuploadError, setReuploadError] = useState<string | null>(null);
  const reuploadInputRef = useRef<HTMLInputElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const dirty = markdown !== profile.markdown;

  async function saveMarkdown() {
    setSavingMarkdown(true);
    try {
      await parseResponse(apiClient.api.profile.$patch({ json: { markdown } }));
      void revalidator.revalidate();
      setEditing(false);
    } finally {
      setSavingMarkdown(false);
    }
  }

  function cancelEdit() {
    setMarkdown(profile.markdown);
    setEditing(false);
  }

  async function handleDelete() {
    setDeleteError(null);
    setDeleting(true);
    try {
      await parseResponse(apiClient.api.profile.$delete());
      setDeleteOpen(false);
      void revalidator.revalidate();
    } catch (err) {
      setDeleteError(extractErrorMessage(err) ?? t`Something went wrong. Please try again.`);
    } finally {
      setDeleting(false);
    }
  }

  async function handleReupload(file: File) {
    if (file.type !== "application/pdf") {
      setReuploadError(t`Please upload a PDF.`);
      return;
    }
    setReuploadError(null);
    setReuploading(true);
    try {
      await parseResponse(apiClient.api.profile.upload.$post({ form: { file } }));
      setReuploadOpen(false);
      void revalidator.revalidate();
    } catch (err) {
      setReuploadError(extractErrorMessage(err) ?? t`Something went wrong. Please try again.`);
    } finally {
      setReuploading(false);
    }
  }

  return (
    <>
      <Card.List className="my-auto">
        <Card.Entry>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex items-center gap-1 w-full">
              <Card.Heading>
                <Trans>Your Profile</Trans>
              </Card.Heading>

              <div className="grow" />
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t`Profile actions`} />}>
                  <DotsThreeVerticalIcon size={16} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={editing} onClick={() => setEditing(true)}>
                    <PencilSimpleIcon size={14} />
                    <Trans>Edit profile</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setReuploadOpen(true)}>
                    <FileTextIcon size={14} />
                    <Trans>Re-upload CV</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                    <TrashIcon size={14} />
                    <Trans>Delete CV</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </Card.Entry>
        <Card.Entry>
          {editing ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                rows={20}
                className="font-mono text-xs"
                aria-label={t`Profile markdown`}
              />
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={savingMarkdown}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button size="sm" onClick={() => void saveMarkdown()} disabled={savingMarkdown || !dirty}>
                  {savingMarkdown ? <Spinner /> : <CheckIcon size={14} />}
                  <Trans>Save changes</Trans>
                </Button>
              </div>
            </div>
          ) : (
            <ExpandableMarkdown>{markdown}</ExpandableMarkdown>
          )}
        </Card.Entry>

        <Card.Entry className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <Card.Heading>
            <Trans>Ready to start learning?</Trans>
          </Card.Heading>
          <Button size="lg" onClick={() => navigate(getHomeRoute())} className="w-full sm:w-auto sm:shrink-0">
            <Trans>Continue with this profile</Trans>
            <ArrowRightIcon size={14} />
          </Button>
        </Card.Entry>
      </Card.List>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Delete profile</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                This permanently deletes your profile. Curriculums and assessments will no longer be tailored to your
                background until you upload a new CV. This can&apos;t be undone.
              </Trans>
            </DialogDescription>
          </DialogHeader>

          {deleteError && (
            <p className="text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 rounded-lg">
              {deleteError}
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              <Trans>Cancel</Trans>
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? <Spinner /> : <TrashIcon size={14} />}
              <Trans>Delete profile</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reuploadOpen} onOpenChange={setReuploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Re-upload CV</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Uploading a new CV will replace your current profile, including any manual edits. This can&apos;t be
                undone.
              </Trans>
            </DialogDescription>
          </DialogHeader>

          <input
            ref={reuploadInputRef}
            type="file"
            accept="application/pdf"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleReupload(file);
              e.target.value = "";
            }}
          />

          {reuploadError && (
            <p className="text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 rounded-lg">
              {reuploadError}
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setReuploadOpen(false)} disabled={reuploading}>
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={() => reuploadInputRef.current?.click()} disabled={reuploading}>
              {reuploading ? <Spinner /> : <UploadIcon size={14} />}
              <Trans>Choose new PDF</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const COLLAPSED_HEIGHT = 240;
const COLLAPSED_MASK = "linear-gradient(to bottom, black 50%, transparent 100%)";

function ExpandableMarkdown({ children }: { children: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const measure = () => {
      if (contentRef.current) setContentHeight(contentRef.current.scrollHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [children]);

  const overflowing = contentHeight > COLLAPSED_HEIGHT;
  const collapsed = overflowing && !expanded;
  const maxHeight = !overflowing ? contentHeight || undefined : expanded ? contentHeight : COLLAPSED_HEIGHT;

  return (
    <div className="relative flex flex-col gap-3">
      <div
        className="overflow-hidden transition-[max-height] duration-500 ease-out"
        style={{
          maxHeight,
          maskImage: collapsed ? COLLAPSED_MASK : undefined,
          WebkitMaskImage: collapsed ? COLLAPSED_MASK : undefined,
        }}
      >
        <div ref={contentRef}>
          <Markdown>{children}</Markdown>
        </div>
      </div>
      {collapsed && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-2">
          <Button size="sm" onClick={() => setExpanded(true)} className="pointer-events-auto">
            <CaretDownIcon size={14} />
            <Trans>See all</Trans>
          </Button>
        </div>
      )}
      {overflowing && expanded && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
            <CaretUpIcon size={14} />
            <Trans>Show less</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
