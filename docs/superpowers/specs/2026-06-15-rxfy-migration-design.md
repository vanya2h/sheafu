# rxfy Migration Design

**Date:** 2026-06-15
**Scope:** Full migration of the dashboard web package to rxfy + rxfy-react 1.0.5 as the primary state/store/model framework.

---

## Background

The current client-side state management is a mix of:

- **React Router root loader** — one large DB fetch returning all user progress as flat JSON; consumed via `useRouteLoaderData("root")` through a `useRootData()` hook.
- **`useProgress()`** — reads root loader data, exposes `{ completedTaskIds, activity, startedAt, activeSessions, toggleTask }`. Every mutation calls `revalidate()`, re-running the entire root loader.
- **`@vanya2h/utils-rxjs-react`** (v0.8.0-rc.1) — provides only `<Pending>`; already used in 8 routes.
- **Raw RxJS** — topic study/assess/feedback/hands-on routes use `BehaviorSubject`, `Subject`, `scan`, `combineLatest`, `shareReplay` directly for LLM streaming state.
- **`rateLimitBus`** — a `mitt` event emitter for cross-component rate limit events.
- **`jotai`** — listed as a dependency but unused.

Pain points: full-page revalidation on every task toggle; verbose RxJS boilerplate in topic routes; multiple ad-hoc reactive patterns for similar problems.

---

## Approach

**Option B — Infrastructure-First Sweep** (selected): three independently shippable phases, each building on the last. The codebase is always in a working state between phases.

---

## Architecture

### Three-layer contract

1. **React Router loaders** — remain the only place that touches the DB on the server. They continue to return JSON as today. No new responsibilities.

2. **`useStateData(state, fetchFn, params, defaultValue)`** — bridges loader JSON into rxfy stores on first render. On the server: uses `defaultValue` directly (no network call). On the client: uses the hydrated store (no re-fetch). `fetchFn` is only invoked on cold client-side navigations to pages not yet visited.

3. **rxfy stores and mutations** — own all client-side reactive updates. Once a store is seeded, all writes go through typed `mutations` (optimistic, instant). No `revalidate()` anywhere.

### SSR dehydration / hydration

`app/entry.server.tsx` creates a per-request `IModelRegistry` and wraps `ServerRouter` in `<StoreProvider registry={registry} ssr>`. When components call `useStateData` with a `defaultValue`, rxfy normalizes the data into the registry during rendering. After `onAllReady`, `hydrationScript(dehydrate(registry))` is appended to the HTML stream.

`app/entry.client.tsx` wraps `HydratedRouter` in `<StoreProvider ssr>`, which reads `window.__RXFY_SSR__` on mount and pre-populates all stores before the first React render.

### `apiClient` on the server

With the `defaultValue` approach, `fetchFn` is **never called during SSR**. rxfy uses `defaultValue` directly and skips the fetch entirely. `apiClient` therefore requires no server-side configuration — it stays as today's module-level singleton. `fetchFn` is only invoked on the client for cold re-fetches (e.g. navigating to a route not previously visited in this session).

---

## Models

All definitions live in `src/lib/models/`.

### Progress (`src/lib/models/progress.ts`)

| Model | Key | Shape |
|---|---|---|
| `TaskCompletionModel` | `taskId` | `{ taskId: string; completedAt: string }` |
| `DailyActivityModel` | `date` | `{ date: string; taskIds: string[]; minutes: number }` |
| `ActiveSessionModel` | `taskId` | `{ taskId: string; name: PhaseKey; partIdx?: number }` |

### Curricula (`src/lib/models/curriculum.ts`)

| Model | Key | Shape |
|---|---|---|
| `CustomCurriculumModel` | `id` | Mirrors `CurriculumDef` (already has `id`) |

### Not migrated to models

`user`, `onboarding`, `startedAt`, `profile`, `hasDrafts` — read-only on the client, no reactive mutations needed. Stay as plain loader return values consumed via `useLoaderData`.

---

## State Descriptors (`defineState`)

### `progressState` (`src/lib/state/progress.ts`)

```ts
export const progressState = defineState({
  key: "progress",
  params: z.object({}),
  model: {
    completions:    array(TaskCompletionModel),
    activity:       array(DailyActivityModel),
    activeSessions: array(ActiveSessionModel),
  },
  mutations: {
    toggleTask: (prev, taskId: string) => ({
      ...prev,
      completions: prev.completions.some(c => c.taskId === taskId)
        ? prev.completions.filter(c => c.taskId !== taskId)
        : [...prev.completions, { taskId, completedAt: new Date().toISOString() }],
    }),
    setActiveSession: (prev, session: ActiveSessionModel) => ({
      ...prev,
      activeSessions: [
        ...prev.activeSessions.filter(s => s.taskId !== session.taskId),
        session,
      ],
    }),
    clearActiveSession: (prev, taskId: string) => ({
      ...prev,
      activeSessions: prev.activeSessions.filter(s => s.taskId !== taskId),
    }),
  },
});
```

### `curriculaState` (`src/lib/state/curricula.ts`)

```ts
export const curriculaState = defineState({
  key: "curricula",
  params: z.object({}),
  model: { curricula: array(CustomCurriculumModel) },
  // No client mutations — publishing goes through a full navigation
});
```

---

## Atoms

Defined in `src/lib/atoms.ts`.

| Atom | Type | Replaces |
|---|---|---|
| `rateLimitEvent$` | `createAtom<RateLimitEvent \| null>(null)` | `rateLimitBus` (mitt) |
| Per-stream LLM atoms | `createAtom<LlmStreamState>` | `BehaviorSubject` in `createLlmStream` |

---

## Phase 1 — Foundation

**Goal:** rxfy available throughout the app, SSR wired, no data migration yet. App behaviour identical to today.

### Package changes

| Action | Package |
|---|---|
| Add | `rxfy@1.0.5`, `rxfy-react@1.0.5` |
| Remove | `@vanya2h/utils-rxjs-react`, `jotai`, `mitt` |

### New files

- `app/entry.server.tsx` — per-request `IModelRegistry`, `<StoreProvider registry ssr>` wrapping `ServerRouter`, `hydrationScript` injection after HTML stream.
- `app/entry.client.tsx` — `<StoreProvider ssr>` wrapping `HydratedRouter`.

### Modified files

8 routes that import `Pending` from `@vanya2h/utils-rxjs-react` — import path changed to `rxfy-react`. No logic change.

```
app/routes/topic.study.tsx
app/routes/topic.assess.tsx
app/routes/topic.gaps.tsx
app/routes/topic.feedback.tsx
app/routes/topic.hands-on.tsx
app/routes/topic.write-up.tsx
app/routes/curriculum.draft.outline.tsx
app/routes/curriculum.draft.phases.tsx
```

---

## Phase 2 — Progress Layer

**Goal:** stores seeded from root loader data; `revalidate()` eliminated from the progress flow.

### New files

- `src/lib/models/progress.ts` — `TaskCompletionModel`, `DailyActivityModel`, `ActiveSessionModel`
- `src/lib/models/curriculum.ts` — `CustomCurriculumModel`
- `src/lib/state/progress.ts` — `progressState` with all mutations
- `src/lib/state/curricula.ts` — `curriculaState`

### `app/root.tsx` — `useStateData` call site

The root `App` component calls `useStateData` twice, seeding from loader data:

```ts
// Map loader's Record<key, value> shapes → arrays rxfy expects
const progressDefaultValue = progress ? {
  completions:    Object.entries(progress.completedTaskIds)
                    .map(([taskId, completedAt]) => ({ taskId, completedAt })),
  activity:       Object.values(progress.activity),
  activeSessions: Object.entries(progress.activeSessions)
                    .map(([taskId, s]) => ({ taskId, ...s })),
} : null;

const curriculaDefaultValue = { curricula: customCurriculums ?? [] };

const { mutations } = useStateData(
  progressState,
  () => apiClient.api.progress.$get().then(r => r.json()),
  {},
  progressDefaultValue,
);

useStateData(
  curriculaState,
  () => apiClient.api.curriculums.$get().then(r => r.json()),
  {},
  curriculaDefaultValue,
);
```

`mutations` is stable; it is provided to the subtree via `ProgressMutationsContext`.

### Hooks rewritten (public API preserved)

**`src/hooks/useProgress.ts`** — rewritten internally. Reads `TaskCompletionModel` store via `useModelStore`; calls `mutations.toggleTask(taskId)` then fires `apiClient.api.progress.tasks[":taskId"].toggle.$post(...)` in parallel. `useRevalidator` removed.

**`src/hooks/useAllCurriculums.ts`** — reads `CustomCurriculumModel` store via `useModelStore` for custom curricula; static curricula still come from `listCurriculums(locale)`.

### Components

`TaskRow`, `Dashboard`, `Curriculum`, `topic-layout` — call `useProgress()` whose public shape is unchanged. **No changes required in these files.**

### Out of scope for Phase 2

`useRootData` and all reads of `user`, `onboarding`, `locale`, `profile` — untouched. They don't need reactive mutations.

---

## Phase 3 — Client State Layer

**Goal:** eliminate mitt, eliminate raw `Subject`/`BehaviorSubject`/`scan`/`shareReplay` boilerplate. All reactive state goes through rxfy.

### `rateLimitBus` → atom

- `src/lib/rateLimitBus.ts` — **deleted**
- `src/lib/atoms.ts` — new: `export const rateLimitEvent$ = createAtom<RateLimitEvent | null>(null)`
- `src/lib/llmStream.ts` — `rateLimitBus.emit(...)` → `rateLimitEvent$.set(...)`
- `src/components/RateLimitModal.tsx` — `useEffect` with `on`/`off` → `const [event] = useAtom(rateLimitEvent$)`

### `getLlmStream` → `createLlmAtom`

`BehaviorSubject(nonce)` + `switchMap` + `createStream` + `shareReplay` replaced by an `IAtom<LlmStreamState>` with a manual `AbortController` for retry isolation:

```ts
export function createLlmAtom(fetcher: LlmFetcher): LlmStream {
  const state$ = createAtom<LlmStreamState>({ status: "streaming", text: "" });
  let controller: AbortController | null = null;

  async function execute() {
    controller?.abort();
    controller = new AbortController();
    state$.set({ status: "streaming", text: "" });
    try {
      const res = await fetcher(controller.signal);
      let acc = "";
      for await (const delta of readSSEStream(res.body!)) {
        if (controller.signal.aborted) return;
        acc += delta;
        state$.set({ status: "streaming", text: acc });
      }
      if (!controller.signal.aborted) state$.set({ status: "complete", text: acc });
    } catch (err) {
      if (!controller.signal.aborted) state$.set({ status: "error", error: err });
    }
  }

  void execute();
  return { state$, retry: () => void execute() };
}
```

`LlmStream.state$` becomes `IAtom<LlmStreamState>` instead of `Observable<LlmStreamState>`. The module-level `cache` and all `getLlmStream` call sites are unchanged.

### Topic/draft routes — Subject → atom

Pattern replaced across all 8 routes:

```ts
// Before — 6 operators for one piece of state
const [updates$] = useState(() => new Subject<MaterialUpdate>());
const material$ = useMemo(
  () => updates$.pipe(scan(reduceMaterial, initial), startWith(initial), shareReplay({...})),
  [updates$, initial],
);
updates$.next({ kind: "plan", plan });

// After — one atom
const material$ = useMemo(() => createAtom<Material | null>(initial), []);
material$.modify(prev => reduceMaterial(prev, { kind: "plan", plan }));
```

`combineLatest([material$, partIdx$])` remains — both are atoms (Observables), the combinator is unchanged. RxJS operators are kept only where they genuinely combine multiple streams.

---

## Deleted dependencies after all three phases

| Package | Replaced by |
|---|---|
| `@vanya2h/utils-rxjs-react` | `rxfy-react` |
| `jotai` | rxfy atoms |
| `mitt` | rxfy atom (`rateLimitEvent$`) |

---

## Definition of Done

Each phase is complete when:
1. `pnpm --filter web run typecheck` passes with no errors
2. `pnpm run lint:fix` passes with no errors
3. All task toggles, LLM streams, and rate-limit modals work correctly in the browser
