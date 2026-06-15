# rxfy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the dashboard web package to rxfy + rxfy-react 1.0.5 as the primary state framework, eliminating `revalidate()` and raw RxJS boilerplate.

**Architecture:** React Router loaders continue fetching from DB and returning JSON. Components pass that data as the `defaultValue` (4th arg) to `useStateData`, seeding rxfy stores on first render. All subsequent mutations go through rxfy — no `revalidate()` anywhere. SSR dehydration/hydration via `entry.server.tsx` + `entry.client.tsx`.

**Tech Stack:** rxfy 1.0.5, rxfy-react 1.0.5, React Router v7 (SSR), Hono, Prisma, Vitest

---

## File Map

**Phase 1 — Foundation**
- `packages/web/package.json` — add rxfy + rxfy-react; remove @vanya2h/utils-rxjs-react, jotai, mitt
- `packages/web/app/entry.server.tsx` — create: per-request ModelRegistry, StoreProvider ssr, hydrationScript injection
- `packages/web/app/entry.client.tsx` — create: StoreProvider ssr wrapping HydratedRouter
- 8 route files (import swap only): `topic.{study,assess,gaps,feedback,hands-on,write-up}.tsx`, `curriculum.draft.{outline,phases}.tsx`

**Phase 2 — Progress Layer**
- `packages/web/src/lib/models/progress.ts` — create: TaskCompletionModel, DailyActivityModel, ActiveSessionModel
- `packages/web/src/lib/models/curriculum.ts` — create: CustomCurriculumModel
- `packages/web/src/lib/state/progress.ts` — create: progressMutations + progressState
- `packages/web/src/lib/state/progress.test.ts` — create: unit tests for progressMutations
- `packages/web/src/lib/state/curricula.ts` — create: curriculaState
- `packages/web/src/lib/context/progressMutations.ts` — create: ProgressMutationsContext + useProgressMutations
- `packages/web/src/server/routes/progress.ts` — modify: add activeSessions to GET /progress; reshape response to arrays
- `packages/web/src/server/routes/curriculum.ts` — modify: add GET /curriculums/published
- `packages/web/app/root.tsx` — modify: useStateData calls in App, ProgressMutationsContext.Provider
- `packages/web/src/hooks/useProgress.ts` — modify: use ModelStore + useProgressMutations
- `packages/web/src/hooks/useTopicSession.ts` — modify: call setActiveSession/clearActiveSession mutations
- `packages/web/src/hooks/useAllCurriculums.ts` — modify: use CustomCurriculumModel store

**Phase 3 — Client State**
- `packages/web/src/lib/atoms.ts` — create: rateLimitEvent$
- `packages/web/src/lib/rateLimitBus.ts` — delete
- `packages/web/src/lib/llmStream.ts` — modify: createLlmAtom replaces createLlmStream internals
- `packages/web/src/components/RateLimitModal.tsx` — modify: useAtom instead of mitt
- `packages/web/app/routes/topic.study.tsx` — modify: Subject → createAtom

---

## Phase 1 — Foundation

### Task 1: Install packages and swap Pending imports

**Files:**
- Modify: `packages/web/package.json`
- Modify: `packages/web/app/routes/topic.study.tsx`
- Modify: `packages/web/app/routes/topic.assess.tsx`
- Modify: `packages/web/app/routes/topic.gaps.tsx`
- Modify: `packages/web/app/routes/topic.feedback.tsx`
- Modify: `packages/web/app/routes/topic.hands-on.tsx`
- Modify: `packages/web/app/routes/topic.write-up.tsx`
- Modify: `packages/web/app/routes/curriculum.draft.outline.tsx`
- Modify: `packages/web/app/routes/curriculum.draft.phases.tsx`

- [ ] **Step 1: Add rxfy packages**

```bash
cd packages/web
pnpm add rxfy@1.0.5 rxfy-react@1.0.5
pnpm remove @vanya2h/utils-rxjs-react jotai mitt
```

- [ ] **Step 2: Swap the Pending import in all 8 routes**

In every file listed above, change:
```ts
import { Pending } from "@vanya2h/utils-rxjs-react";
```
to:
```ts
import { Pending } from "rxfy-react";
```

- [ ] **Step 3: Verify typecheck passes**

```bash
pnpm --filter web run typecheck
```

Expected: no errors (rxfy-react exports the same `Pending` component API).

- [ ] **Step 4: Commit**

```bash
git add packages/web/package.json packages/web/app/routes/topic.study.tsx packages/web/app/routes/topic.assess.tsx packages/web/app/routes/topic.gaps.tsx packages/web/app/routes/topic.feedback.tsx packages/web/app/routes/topic.hands-on.tsx packages/web/app/routes/topic.write-up.tsx packages/web/app/routes/curriculum.draft.outline.tsx packages/web/app/routes/curriculum.draft.phases.tsx
git commit -m "chore: install rxfy 1.0.5, swap Pending import source"
```

---

### Task 2: Create SSR entry files

**Files:**
- Create: `packages/web/app/entry.server.tsx`
- Create: `packages/web/app/entry.client.tsx`

- [ ] **Step 1: Create `app/entry.server.tsx`**

```tsx
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { createModelRegistry, dehydrate, hydrationScript } from "rxfy";
import { StoreProvider } from "rxfy-react";

const ABORT_DELAY = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  return isbot(request.headers.get("user-agent") ?? "")
    ? handleBuffered(request, responseStatusCode, responseHeaders, routerContext)
    : handleBuffered(request, responseStatusCode, responseHeaders, routerContext);
}

function handleBuffered(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  return new Promise<Response>((resolve, reject) => {
    const registry = createModelRegistry();

    const { pipe, abort } = renderToPipeableStream(
      <StoreProvider registry={registry} ssr>
        <ServerRouter context={routerContext} url={request.url} abortDelay={ABORT_DELAY} />
      </StoreProvider>,
      {
        onAllReady() {
          const snapshot = dehydrate(registry);
          const chunks: Buffer[] = [];
          const intermediate = new PassThrough();

          intermediate.on("data", (chunk: Buffer) => chunks.push(chunk));
          intermediate.on("end", () => {
            const body = new PassThrough();
            responseHeaders.set("Content-Type", "text/html");
            resolve(
              new Response(createReadableStreamFromReadable(body), {
                headers: responseHeaders,
                status: responseStatusCode,
              }),
            );
            for (const chunk of chunks) body.write(chunk);
            body.write(hydrationScript(snapshot));
            body.end();
          });

          pipe(intermediate);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    setTimeout(abort, ABORT_DELAY);
  });
}
```

- [ ] **Step 2: Create `app/entry.client.tsx`**

```tsx
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { StoreProvider } from "rxfy-react";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StoreProvider ssr>
        <HydratedRouter />
      </StoreProvider>
    </StrictMode>,
  );
});
```

- [ ] **Step 3: Verify typecheck passes**

```bash
pnpm --filter web run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/app/entry.server.tsx packages/web/app/entry.client.tsx
git commit -m "feat: add SSR entry files with rxfy StoreProvider"
```

---

## Phase 2 — Progress Layer

### Task 3: Extend API endpoints

The `fetchFn` passed to `useStateData` for cold client re-fetches needs API endpoints that return arrays matching the model shapes. The existing `GET /api/progress` returns Records; update it to return arrays and add `activeSessions`. Add `GET /api/curriculums/published` for custom curricula.

**Files:**
- Modify: `packages/web/src/server/routes/progress.ts`
- Modify: `packages/web/src/server/routes/curriculum.ts`

- [ ] **Step 1: Update GET /api/progress in `src/server/routes/progress.ts`**

Replace the existing `GET /progress` handler (lines 14–30) with:

```ts
.get("/progress", async (c) => {
  const userId = c.var.user.id;

  const [completions, activities, topicSessions] = await Promise.all([
    db.taskCompletion.findMany({ where: { userId } }),
    db.dailyActivity.findMany({ where: { userId } }),
    db.topicSession.findMany({ where: { userId } }),
  ]);

  const activeSessions = topicSessions.flatMap((s) => {
    const state = parseTopicSessionState(s.phaseData);
    const top = highestPhase(state);
    if (!top) return [];
    const phase = state.phases[top];
    if (!phase) return [];
    const partIdx = "partIdx" in phase ? phase.partIdx : undefined;
    return [{ taskId: s.taskId, name: top, partIdx }];
  });

  return c.json({
    completions: completions.map((t) => ({
      taskId: t.taskId,
      completedAt: t.completedAt.toISOString(),
    })),
    activity: activities.map((a) => ({
      date: a.date,
      taskIds: a.taskIds as string[],
      minutes: a.minutes,
    })),
    activeSessions,
  });
})
```

Also add the two missing imports at the top of the file:

```ts
import { highestPhase, parseTopicSessionState } from "../../lib/phase";
```

- [ ] **Step 2: Add GET /api/curriculums/published to `src/server/routes/curriculum.ts`**

After the `.get("/curriculums/drafts", ...)` handler (around line 397), add:

```ts
.get("/curriculums/published", async (c) => {
  const userId = c.var.user.id;
  const records = await db.customCurriculum.findMany({
    where: { userId, status: "published" },
  });
  return c.json({ curricula: records.map((r) => ({ ...r })) });
})
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/server/routes/progress.ts packages/web/src/server/routes/curriculum.ts
git commit -m "feat: extend progress API with activeSessions; add published curricula endpoint"
```

---

### Task 4: Create models and state descriptors

**Files:**
- Create: `packages/web/src/lib/models/progress.ts`
- Create: `packages/web/src/lib/models/curriculum.ts`
- Create: `packages/web/src/lib/state/progress.ts`
- Create: `packages/web/src/lib/state/progress.test.ts`
- Create: `packages/web/src/lib/state/curricula.ts`

- [ ] **Step 1: Write failing tests for progress mutations**

Create `packages/web/src/lib/state/progress.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { progressMutations } from "./progress";

const empty = { completions: [], activity: [], activeSessions: [] };

describe("progressMutations.toggleTask", () => {
  it("adds a completion when task is not yet complete", () => {
    const result = progressMutations.toggleTask(empty, "task-1");
    expect(result.completions).toHaveLength(1);
    expect(result.completions[0]).toMatchObject({ taskId: "task-1" });
    expect(typeof result.completions[0]?.completedAt).toBe("string");
  });

  it("removes a completion when task is already complete", () => {
    const withOne = progressMutations.toggleTask(empty, "task-1");
    const result = progressMutations.toggleTask(withOne, "task-1");
    expect(result.completions).toHaveLength(0);
  });

  it("does not affect other completions when toggling", () => {
    const withTwo = progressMutations.toggleTask(
      progressMutations.toggleTask(empty, "task-1"),
      "task-2",
    );
    const result = progressMutations.toggleTask(withTwo, "task-1");
    expect(result.completions).toHaveLength(1);
    expect(result.completions[0]?.taskId).toBe("task-2");
  });
});

describe("progressMutations.setActiveSession", () => {
  it("adds a new active session", () => {
    const result = progressMutations.setActiveSession(empty, {
      taskId: "t1",
      name: "study",
    });
    expect(result.activeSessions).toHaveLength(1);
    expect(result.activeSessions[0]).toMatchObject({ taskId: "t1", name: "study" });
  });

  it("replaces an existing session for the same taskId", () => {
    const withSession = progressMutations.setActiveSession(empty, {
      taskId: "t1",
      name: "study",
    });
    const result = progressMutations.setActiveSession(withSession, {
      taskId: "t1",
      name: "hands-on",
      partIdx: 2,
    });
    expect(result.activeSessions).toHaveLength(1);
    expect(result.activeSessions[0]).toMatchObject({ taskId: "t1", name: "hands-on", partIdx: 2 });
  });
});

describe("progressMutations.clearActiveSession", () => {
  it("removes an active session by taskId", () => {
    const withSession = progressMutations.setActiveSession(empty, {
      taskId: "t1",
      name: "study",
    });
    const result = progressMutations.clearActiveSession(withSession, "t1");
    expect(result.activeSessions).toHaveLength(0);
  });

  it("does nothing when taskId not present", () => {
    const result = progressMutations.clearActiveSession(empty, "nonexistent");
    expect(result.activeSessions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter web run test
```

Expected: fails with "Cannot find module './progress'".

- [ ] **Step 3: Create `src/lib/models/progress.ts`**

```ts
import { createModel } from "rxfy";
import { z } from "zod";

export const TaskCompletionModel = createModel(
  z.object({ taskId: z.string(), completedAt: z.string() }),
  { getKey: (e) => e.taskId, name: "TaskCompletion" },
);

export const DailyActivityModel = createModel(
  z.object({ date: z.string(), taskIds: z.array(z.string()), minutes: z.number() }),
  { getKey: (e) => e.date, name: "DailyActivity" },
);

export const ActiveSessionModel = createModel(
  z.object({ taskId: z.string(), name: z.string(), partIdx: z.number().optional() }),
  { getKey: (e) => e.taskId, name: "ActiveSession" },
);

export type TaskCompletion = z.infer<typeof TaskCompletionModel.schema>;
export type DailyActivity = z.infer<typeof DailyActivityModel.schema>;
export type ActiveSession = z.infer<typeof ActiveSessionModel.schema>;
```

- [ ] **Step 4: Create `src/lib/models/curriculum.ts`**

```ts
import { createModel } from "rxfy";
import { z } from "zod";

export const CustomCurriculumModel = createModel(
  z.object({ id: z.string() }).passthrough(),
  { getKey: (e) => e.id, name: "CustomCurriculum" },
);
```

- [ ] **Step 5: Create `src/lib/state/progress.ts`**

```ts
import { array, defineState } from "rxfy";
import { z } from "zod";
import { ActiveSessionModel, DailyActivityModel, TaskCompletionModel } from "../models/progress";
import type { ActiveSession, DailyActivity, TaskCompletion } from "../models/progress";

type ProgressShape = {
  completions: TaskCompletion[];
  activity: DailyActivity[];
  activeSessions: ActiveSession[];
};

export const progressMutations = {
  toggleTask: (prev: ProgressShape, taskId: string): ProgressShape => ({
    ...prev,
    completions: prev.completions.some((c) => c.taskId === taskId)
      ? prev.completions.filter((c) => c.taskId !== taskId)
      : [...prev.completions, { taskId, completedAt: new Date().toISOString() }],
  }),

  setActiveSession: (
    prev: ProgressShape,
    session: ActiveSession,
  ): ProgressShape => ({
    ...prev,
    activeSessions: [
      ...prev.activeSessions.filter((s) => s.taskId !== session.taskId),
      session,
    ],
  }),

  clearActiveSession: (prev: ProgressShape, taskId: string): ProgressShape => ({
    ...prev,
    activeSessions: prev.activeSessions.filter((s) => s.taskId !== taskId),
  }),
};

export const progressState = defineState({
  key: "progress",
  params: z.object({}),
  model: {
    completions: array(TaskCompletionModel),
    activity: array(DailyActivityModel),
    activeSessions: array(ActiveSessionModel),
  },
  mutations: progressMutations,
});

// Bound mutation signatures (rxfy strips the `prev` arg; these are what callers receive)
export type ProgressMutations = {
  toggleTask: (taskId: string) => void;
  setActiveSession: (session: ActiveSession) => void;
  clearActiveSession: (taskId: string) => void;
};
```

- [ ] **Step 6: Create `src/lib/state/curricula.ts`**

```ts
import { array, defineState } from "rxfy";
import { z } from "zod";
import { CustomCurriculumModel } from "../models/curriculum";

export const curriculaState = defineState({
  key: "curricula",
  params: z.object({}),
  model: { curricula: array(CustomCurriculumModel) },
});
```

- [ ] **Step 7: Run tests to confirm they pass**

```bash
pnpm --filter web run test
```

Expected: all tests pass.

- [ ] **Step 8: Verify typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/lib/models/ packages/web/src/lib/state/
git commit -m "feat: add rxfy models and state descriptors for progress and curricula"
```

---

### Task 5: Create ProgressMutationsContext

**Files:**
- Create: `packages/web/src/lib/context/progressMutations.ts`

- [ ] **Step 1: Create the context file**

```ts
import { createContext, use } from "react";
import type { ProgressMutations } from "../state/progress";

export const ProgressMutationsContext = createContext<ProgressMutations | null>(null);

export function useProgressMutations(): ProgressMutations {
  const ctx = use(ProgressMutationsContext);
  if (!ctx) throw new Error("useProgressMutations must be used inside ProgressMutationsContext");
  return ctx;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/context/
git commit -m "feat: add ProgressMutationsContext"
```

---

### Task 6: Wire useStateData in app/root.tsx

**Files:**
- Modify: `packages/web/app/root.tsx`

- [ ] **Step 1: Add the useStateData calls and context provider to `app/root.tsx`**

Replace the existing `export default function App()` with:

```tsx
export default function App() {
  const { locale, progress, customCurriculums } = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();  // keep for now, will be removed after useProgress rewrite

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
    progressDefaultValue,
  );

  useStateData(
    curriculaState,
    () => apiClient.api.curriculums.published.$get().then((r) => r.json()),
    {},
    { curricula: customCurriculums ?? [] },
  );

  return (
    <ProgressMutationsContext value={mutations}>
      <I18nProvider i18n={i18n}>
        <Outlet />
        <RateLimitModal />
      </I18nProvider>
    </ProgressMutationsContext>
  );
}
```

Add these imports at the top of `app/root.tsx`:

```ts
import { useStateData } from "rxfy-react";
import { apiClient } from "~/lib/apiClient";
import { ProgressMutationsContext } from "~/lib/context/progressMutations";
import { curriculaState } from "~/lib/state/curricula";
import { progressState } from "~/lib/state/progress";
```

Also keep `useRevalidator` imported — it will be removed in Task 7 once `useProgress` no longer needs it.

- [ ] **Step 2: Verify typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/root.tsx
git commit -m "feat: seed rxfy stores from root loader via useStateData defaultValue"
```

---

### Task 7: Rewrite useProgress, useTopicSession, and useAllCurriculums

This is where `revalidate()` is eliminated. The public API of `useProgress` stays the same so call sites require no changes.

**Files:**
- Modify: `packages/web/src/hooks/useProgress.ts`
- Modify: `packages/web/src/hooks/useTopicSession.ts`
- Modify: `packages/web/src/hooks/useAllCurriculums.ts`

- [ ] **Step 1: Rewrite `src/hooks/useProgress.ts`**

```ts
import { parseResponse } from "hono/client";
import { useMemo } from "react";
import { useModelStore } from "rxfy-react";
import { useRootData } from "../../app/hooks/useRootData";
import { apiClient } from "../lib/apiClient";
import { useProgressMutations } from "../lib/context/progressMutations";
import { ActiveSessionModel, TaskCompletionModel } from "../lib/models/progress";
import type { PersistedPhase } from "../lib/phase";

export type ActivityEntry = {
  date: string;
  taskIds: string[];
  minutes: number;
};

export type ActiveSession = {
  name: PersistedPhase["name"];
  partIdx?: number;
};

export type Progress = {
  completedTaskIds: Record<string, string>;
  activity: Record<string, ActivityEntry>;
  startedAt: string;
  activeSessions: Record<string, ActiveSession>;
};

export function useProgress() {
  const data = useRootData();
  const mutations = useProgressMutations();
  const completionStore = useModelStore(TaskCompletionModel);
  const sessionStore = useModelStore(ActiveSessionModel);

  // Build Records from store snapshots for backwards-compatible shape
  const completedTaskIds = useMemo(() => {
    const map: Record<string, string> = {};
    completionStore.getAll().forEach((c) => {
      map[c.taskId] = c.completedAt;
    });
    return map;
  }, [completionStore]);

  const activeSessions = useMemo(() => {
    const map: Record<string, ActiveSession> = {};
    sessionStore.getAll().forEach((s) => {
      map[s.taskId] = { name: s.name as PersistedPhase["name"], partIdx: s.partIdx };
    });
    return map;
  }, [sessionStore]);

  async function toggleTask(taskId: string) {
    mutations.toggleTask(taskId);
    await parseResponse(
      apiClient.api.progress.tasks[":taskId"].toggle.$post({ param: { taskId } }),
    );
  }

  return {
    completedTaskIds,
    activity: (data?.progress?.activity ?? {}) as Record<string, ActivityEntry>,
    startedAt: data?.progress?.startedAt ?? new Date().toISOString(),
    activeSessions,
    toggleTask,
  };
}
```

> **Note on `getAll()`:** `ModelStore` exposes `getAll()` to iterate over current store contents synchronously. If the rxfy 1.0.5 API uses a different method name (e.g., `values()` or iteration via `added$`), check the rxfy-react type definitions and adjust accordingly.

- [ ] **Step 2: Rewrite `src/hooks/useTopicSession.ts`**

```ts
import { parseResponse } from "hono/client";
import { useMemo } from "react";
import { apiClient } from "../lib/apiClient";
import { useProgressMutations } from "../lib/context/progressMutations";
import { highestPhase, parseTopicSessionState } from "../lib/phase";
import type { PersistedPhase } from "../lib/phase";

export function useTopicSession(taskId: string) {
  const mutations = useProgressMutations();

  return useMemo(
    () => ({
      saveSession: async (phase: PersistedPhase) => {
        const result = await parseResponse(
          apiClient.api["topic-sessions"][":taskId"].$put({
            param: { taskId },
            json: { phase },
          }),
        );
        const state = { phases: { [phase.name]: phase } as Parameters<typeof highestPhase>[0]["phases"] };
        const top = highestPhase({ phases: state.phases });
        if (top) {
          const partIdx = "partIdx" in phase ? phase.partIdx : undefined;
          mutations.setActiveSession({ taskId, name: top, partIdx });
        }
        return result;
      },
      deleteSession: async () => {
        const result = await parseResponse(
          apiClient.api["topic-sessions"][":taskId"].$delete({ param: { taskId } }),
        );
        mutations.clearActiveSession(taskId);
        return result;
      },
    }),
    [taskId, mutations],
  );
}
```

- [ ] **Step 3: Rewrite `src/hooks/useAllCurriculums.ts`**

```ts
import { useMemo } from "react";
import { useModelStore } from "rxfy-react";
import { listCurriculums } from "../data/curriculum";
import type { CurriculumDef } from "../data/types";
import { parseCurriculumDef } from "../data/types";
import { CustomCurriculumModel } from "../lib/models/curriculum";
import { useLocale } from "../../app/hooks/useLocale";

export function useAllCurriculums(): CurriculumDef[] {
  const locale = useLocale();
  const store = useModelStore(CustomCurriculumModel);

  return useMemo(() => {
    const custom = store
      .getAll()
      .map((raw) => parseCurriculumDef(raw as Parameters<typeof parseCurriculumDef>[0]))
      .filter((c): c is CurriculumDef => c !== null);
    return [...listCurriculums(locale), ...custom];
  }, [locale, store]);
}
```

- [ ] **Step 4: Remove `useRevalidator` from `app/root.tsx`**

In `app/root.tsx`, remove the `useRevalidator` import and the `const { revalidate } = useRevalidator();` line — it was kept as a placeholder during Task 6 but is no longer needed.

- [ ] **Step 5: Verify typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors. If `getAll()` is not in the rxfy-react types, check `ModelStore`'s actual API and update the calls in `useProgress` and `useAllCurriculums` to use the correct method.

- [ ] **Step 6: Run all tests**

```bash
pnpm --filter web run test
```

Expected: all pass.

- [ ] **Step 7: Run the dev server and manually verify**

```bash
pnpm --filter web run dev
```

Open the browser. Check:
- Task checkboxes toggle immediately (no loading delay, no page-wide reload)
- Curriculum page shows correct completion counts
- Topic sidebar shows correct phase progress
- Refreshing the page shows the same state (loader re-seeds the stores correctly)

- [ ] **Step 8: Lint and commit**

```bash
pnpm run lint:fix
git add packages/web/src/hooks/ packages/web/app/root.tsx
git commit -m "feat: replace useProgress revalidate with rxfy store mutations"
```

---

## Phase 3 — Client State

### Task 8: Replace rateLimitBus with an atom

**Files:**
- Create: `packages/web/src/lib/atoms.ts`
- Delete: `packages/web/src/lib/rateLimitBus.ts`
- Modify: `packages/web/src/lib/llmStream.ts`
- Modify: `packages/web/src/components/RateLimitModal.tsx`

- [ ] **Step 1: Create `src/lib/atoms.ts`**

```ts
import { createAtom } from "rxfy";

export type RateLimitEvent = {
  resetAt: Date;
  used: number;
  limit: number;
};

export const rateLimitEvent$ = createAtom<RateLimitEvent | null>(null);
```

- [ ] **Step 2: Update `src/lib/llmStream.ts` to use the atom**

Replace:
```ts
import { rateLimitBus } from "./rateLimitBus";
```
with:
```ts
import { rateLimitEvent$ } from "./atoms";
```

Replace:
```ts
rateLimitBus.emit("rateLimit", {
  resetAt: typeof data?.resetAt === "string" ? new Date(data.resetAt) : new Date(Date.now() + 3_600_000),
  used: typeof data?.used === "number" ? data.used : 0,
  limit: typeof data?.limit === "number" ? data.limit : 10_000,
});
```
with:
```ts
rateLimitEvent$.set({
  resetAt: typeof data?.resetAt === "string" ? new Date(data.resetAt) : new Date(Date.now() + 3_600_000),
  used: typeof data?.used === "number" ? data.used : 0,
  limit: typeof data?.limit === "number" ? data.limit : 10_000,
});
```

- [ ] **Step 3: Update `src/components/RateLimitModal.tsx`**

Find all usages of `rateLimitBus`. Replace the mitt subscription pattern with `useAtom`:

```tsx
import { useAtom } from "rxfy-react";
import { rateLimitEvent$ } from "~/lib/atoms";

// Inside the component, replace the useEffect/on/off pattern with:
const [rateLimitEvent, setRateLimitEvent] = useAtom(rateLimitEvent$);

// Replace any handlers that called rateLimitBus.off with:
// setRateLimitEvent(null) to dismiss
```

Read the current `RateLimitModal.tsx` to see the exact shape and adapt accordingly — the atom replaces the event listener but the modal's open/close logic remains the same.

- [ ] **Step 4: Delete `src/lib/rateLimitBus.ts`**

```bash
rm packages/web/src/lib/rateLimitBus.ts
```

- [ ] **Step 5: Verify typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors (no remaining references to `rateLimitBus`).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/atoms.ts packages/web/src/lib/llmStream.ts packages/web/src/components/RateLimitModal.tsx
git rm packages/web/src/lib/rateLimitBus.ts
git commit -m "feat: replace rateLimitBus mitt emitter with rxfy atom"
```

---

### Task 9: Rewrite LLM stream factory with createAtom

**Files:**
- Modify: `packages/web/src/lib/llmStream.ts`

- [ ] **Step 1: Rewrite `createLlmStream` as `createLlmAtom` in `src/lib/llmStream.ts`**

Replace the `createLlmStream` function and all its RxJS imports (`BehaviorSubject`, `Observable`, `shareReplay`, `switchMap`) with:

```ts
import type { ClientResponse } from "hono/client";
import { DetailedError, parseResponse } from "hono/client";
import { createAtom } from "rxfy";
import type { IAtom } from "rxfy";
import { rateLimitEvent$ } from "./atoms";

export type LlmStreamState =
  | { status: "streaming"; text: string }
  | { status: "complete"; text: string }
  | { status: "error"; error: unknown };

export type LlmStream = {
  state$: IAtom<LlmStreamState>;
  retry: () => void;
};

export type LlmFetcher = (signal: AbortSignal) => Promise<ClientResponse<unknown>>;

export async function* readSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          yield JSON.parse(line.slice(6)) as string;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createLlmAtom(fetcher: LlmFetcher): LlmStream {
  const state$ = createAtom<LlmStreamState>({ status: "streaming", text: "" });
  let controller: AbortController | null = null;

  async function execute() {
    controller?.abort();
    controller = new AbortController();
    state$.set({ status: "streaming", text: "" });
    try {
      const res = await fetcher(controller.signal);
      if (!res.ok) await parseResponse(res);
      if (!res.body) throw new Error("No response body");
      let acc = "";
      for await (const delta of readSSEStream(res.body)) {
        if (controller.signal.aborted) return;
        acc += delta;
        state$.set({ status: "streaming", text: acc });
      }
      if (!controller.signal.aborted) state$.set({ status: "complete", text: acc });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DetailedError && (err as { statusCode?: unknown }).statusCode === 429) {
        const data = (err as DetailedError).detail?.data;
        rateLimitEvent$.set({
          resetAt: typeof data?.resetAt === "string" ? new Date(data.resetAt) : new Date(Date.now() + 3_600_000),
          used: typeof data?.used === "number" ? data.used : 0,
          limit: typeof data?.limit === "number" ? data.limit : 10_000,
        });
      }
      state$.set({ status: "error", error: err });
    }
  }

  void execute();
  return { state$, retry: () => void execute() };
}

const cache = new Map<string, LlmStream>();

export function getLlmStream(key: string, fetcher: LlmFetcher): LlmStream {
  const cached = cache.get(key);
  if (cached) return cached;
  const stream = createLlmAtom(fetcher);
  cache.set(key, stream);
  return stream;
}
```

> Note: `getLlmStream` signature and all call sites in topic routes are unchanged. Only the internals change.

- [ ] **Step 2: Verify typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors. If `IAtom` is not exported from `rxfy`, check the correct type name in the rxfy 1.0.5 type definitions (`IAtom`, `Atom`, or the return type of `createAtom`).

- [ ] **Step 3: Verify tests still pass**

```bash
pnpm --filter web run test
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/llmStream.ts
git commit -m "feat: replace BehaviorSubject LLM stream with rxfy createAtom"
```

---

### Task 10: Migrate topic.study.tsx Subject usage to atoms

`topic.study.tsx` is the only route that creates inline `Subject` instances. All other routes only use `getLlmStream` (unchanged) and `Pending` (already swapped in Task 1).

**Files:**
- Modify: `packages/web/app/routes/topic.study.tsx`

- [ ] **Step 1: Replace Subject-based state with createAtom in `topic.study.tsx`**

At the top of `StudyView`, replace:

```ts
// REMOVE these two lines:
const [updates$] = useState(() => new Subject<MaterialUpdate>());
const [navigateIdx$] = useState(() => new Subject<number>());

// REMOVE material$ derived observable (scan + startWith + shareReplay):
const material$ = useMemo(
  () =>
    updates$.pipe(
      scan(reduceMaterial, initialMaterial),
      startWith(initialMaterial),
      shareReplay({ bufferSize: 1, refCount: false }),
    ),
  [updates$, initialMaterial],
);

// REMOVE partIdx$ derived observable (startWith + distinctUntilChanged + shareReplay):
const partIdx$ = useMemo(
  () =>
    navigateIdx$.pipe(
      startWith(initialPartIdx),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: false }),
    ),
  [navigateIdx$, initialPartIdx],
);
```

with:

```ts
const material$ = useMemo(() => createAtom<Material | null>(initialMaterial), []);
const partIdx$ = useMemo(() => createAtom<number>(initialPartIdx), []);
```

- [ ] **Step 2: Update all mutation call sites in `topic.study.tsx`**

Replace every `updates$.next(...)` call:

```ts
// BEFORE:
updates$.next({ kind: "plan", plan: parsePlan(state.text), assessmentContext });
navigateIdx$.next(0);

// AFTER:
material$.modify((prev) => reduceMaterial(prev, { kind: "plan", plan: parsePlan(state.text), assessmentContext }));
partIdx$.set(0);
```

```ts
// BEFORE:
updates$.next({ kind: "part", idx, part: parsePart(state.text) });

// AFTER:
material$.modify((prev) => reduceMaterial(prev, { kind: "part", idx, part: parsePart(state.text) }));
```

Replace navigation calls in the action bar:

```ts
// BEFORE:
onClick={() => navigateIdx$.next(partIdx - 1)}
onClick={() => navigateIdx$.next(partIdx + 1)}

// AFTER:
onClick={() => partIdx$.set(partIdx - 1)}
onClick={() => partIdx$.set(partIdx + 1)}
```

The `viewState$`, `partStream$`, and `useEffect` subscription are unchanged — they use `combineLatest([material$, partIdx$])` which works on atoms since atoms are Observables.

- [ ] **Step 3: Remove unused imports from `topic.study.tsx`**

Remove from the `rxjs` import line: `Subject`, `scan`, `startWith`, `shareReplay`.

Keep: `combineLatest`, `distinctUntilChanged`, `filter`, `map`, `skip`, `tap`.

Add to the import block:
```ts
import { createAtom } from "rxfy";
```

- [ ] **Step 4: Verify typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run lint**

```bash
pnpm run lint:fix
```

- [ ] **Step 6: Run the dev server and test the study page**

```bash
pnpm --filter web run dev
```

Navigate to any topic's study page. Verify:
- Study plan generates and streams correctly
- Navigating between parts works (Previous / Next buttons)
- Session is auto-saved when navigating between parts
- Retrying after an error works

- [ ] **Step 7: Commit**

```bash
git add packages/web/app/routes/topic.study.tsx
git commit -m "feat: replace Subject boilerplate with rxfy atoms in topic.study"
```

---

### Task 11: Final verification

- [ ] **Step 1: Typecheck**

```bash
pnpm --filter web run typecheck
```

Expected: no errors.

- [ ] **Step 2: Tests**

```bash
pnpm --filter web run test
```

Expected: all pass.

- [ ] **Step 3: Lint**

```bash
pnpm run lint:fix
```

Expected: no errors.

- [ ] **Step 4: Confirm no remaining references to removed packages**

```bash
grep -r "utils-rxjs-react\|rateLimitBus\|from.*mitt\|from.*jotai" packages/web/src packages/web/app --include="*.ts" --include="*.tsx"
```

Expected: no output.

- [ ] **Step 5: Commit any lint-only changes**

```bash
git add -p
git commit -m "chore: final lint fixes for rxfy migration"
```
