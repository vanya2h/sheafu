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
    const withTwo = progressMutations.toggleTask(progressMutations.toggleTask(empty, "task-1"), "task-2");
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
