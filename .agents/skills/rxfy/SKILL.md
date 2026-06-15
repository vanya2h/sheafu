---
name: rxfy
description: Use when working with the rxfy or rxfy-react packages — declaring models and states, subscribing to reactive data in React, handling async status (IDLE/PENDING/FULFILLED/REJECTED), composing nested state with Lens, binding atoms, or calling mutations. Also use when encountering "entity is not loaded" errors or confusion between normalized ids and entity data.
license: MIT
metadata:
  author: vanya2h
  version: "1.0.0"
---

# rxfy

RxJS-backed normalized state management. Entities live in shared `ModelStore`s keyed by id; queries store only ids. A single `store.set` — from a refetch, mutation, or websocket push — reactively updates every component showing that entity.

## Core Building Blocks

| API | What it is |
|-----|-----------|
| `createAtom(value)` | `BehaviorSubject`-backed `Observable<T>` with `.get()`, `.set()`, `.modify()` |
| `createLens(source$, lens)` | Derived `IAtom` over a slice of an `Atom`; `keyLens(key)` for object fields |
| `IWrapped<T>` / `StatusEnum` | `IDLE \| PENDING \| FULFILLED \| REJECTED` discriminated union |
| `createModel(schema, { getKey, name })` | Entity type + id extractor |
| `defineState({ key, params, model, mutations })` | Typed fetch descriptor |
| `ModelStore<T>` | `get(id)`, `set`, `setMany`, `entity(id)`, `added$` |
| `IModelRegistry` | Shared store registry — one per request (SSR) or app lifetime (client) |

## React Bindings (rxfy-react)

```tsx
// 1. Wrap the app once
<StoreProvider>
  <App />
</StoreProvider>

// 2. Fetch and normalize
const { data$, mutations, set, reload } = useStateData(myState, fetchFn, params);
// data$ emits QueryShapeOf<TShape> — arrays become id[], singles become an id string

// 3. Render async state
<Pending value$={data$} pending={<Spinner />} rejected={(w) => <Error err={w.error} />}>
  {({ todos }) => todos.map((id) => <TodoItem key={id} id={id} />)}
</Pending>

// 4. Subscribe to an entity by id
const store = useModelStore(TodoModel);
const todo$ = useMemo(() => store.get(id), [store, id]);
<Pending value$={todo$}>{(todo) => <li>{todo.title}</li>}</Pending>

// 5. Bind an IAtom (Lens / field handle)
const [value, setValue] = useAtom(atom$); // atom$ must be stable across renders
```

### Hook quick-reference

| Hook | Returns | Notes |
|------|---------|-------|
| `useStateData(state, fetchFn, params)` | `StateHandle` | Re-fetches when `params` identity changes |
| `useModelStore(descriptor)` | `ModelStore<T>` | Same descriptor → same store in the registry |
| `useAtom(atom$)` | `[T, set]` | Memoize atom$ — new identity resets |
| `usePending(source$)` | `IWrapped<T>` | Low-level; prefer `<Pending>` for rendering |
| `useObservable(obs$, initial)` | `T` | Raw subscription to any observable |

## Mutations

Mutations receive full denormalized entities, return full entities — rxfy re-normalizes automatically:

```ts
const listState = defineState({
  key: "todos",
  params: z.object({ filter: z.enum(["all", "active", "done"]) }),
  model: { todos: array(Todo) },
  mutations: {
    addTodo: (prev, todo: Todo) => ({ ...prev, todos: [...prev.todos, todo] }),
    toggle: (prev, id: string) => ({
      ...prev,
      todos: prev.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    }),
  },
});

// In component:
mutations.addTodo({ id: crypto.randomUUID(), title: "Buy milk", done: false });
mutations.toggle(id);
```

## Lens for Nested State

```ts
const form$ = createAtom({ name: "", age: 0 });
const name$ = createLens(form$, keyLens("name")); // IAtom<string>
// Writes propagate back to form$; reads are deep-equal deduped
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Rendering `data$` values as entity data | `data$` holds ids — use `useModelStore` + `store.get(id)` for entities |
| `store.entity(id)` throws at runtime | Guard with `<Pending>` or check `store.getValue(id)` first |
| Observable created inline in render | Memoize with `useMemo` — inline obs resets every render and never settles |
| Atom updates not triggering re-render | Consume via `useAtom` or `<Pending>` — plain `.get()` is synchronous only |
| Duplicate model name warning | Each `createModel` call must use a unique `name` across the registry |

> For SSR setup (dehydrate/hydrate, Next.js App Router, buffered/two-pass modes) see the **rxfy-ssr** skill.
