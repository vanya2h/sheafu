import { zValidator } from "@hono/zod-validator";
import { format } from "date-fns";
import { Hono } from "hono";
import { z } from "zod";
import { highestPhase, parseTopicSessionState } from "../../lib/phase";
import { db } from "../db";
import type { AuthEnv } from "../middleware/requireAuth";

function today() {
  return format(new Date(), "yyyy-MM-dd");
}

export const progressRoute = new Hono<AuthEnv>()
  // Returns arrays for rxfy store seeding. startedAt is excluded — served from root loader as read-only data.
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

  // ─── POST /progress/tasks/:taskId/toggle ─────────────────────────────────────
  .post("/progress/tasks/:taskId/toggle", zValidator("param", z.object({ taskId: z.string().min(1) })), async (c) => {
    const userId = c.var.user.id;
    const { taskId } = c.req.valid("param");
    const date = today();

    const existing = await db.taskCompletion.findUnique({
      where: { taskId_userId: { taskId, userId } },
    });

    if (existing) {
      // Un-complete: delete completion + remove from today's activity
      const [, activity] = await db.$transaction([
        db.taskCompletion.delete({ where: { taskId_userId: { taskId, userId } } }),
        db.dailyActivity.findUnique({ where: { date_userId: { date, userId } } }),
      ]);

      if (activity) {
        await db.dailyActivity.update({
          where: { date_userId: { date, userId } },
          data: { taskIds: activity.taskIds.filter((id) => id !== taskId) },
        });
      }

      return c.json({ completed: false });
    }

    // Complete: create completion + upsert today's activity
    const [completion] = await db.$transaction([
      db.taskCompletion.create({ data: { taskId, userId, completedAt: new Date() } }),
      db.dailyActivity.upsert({
        where: { date_userId: { date, userId } },
        update: { taskIds: { push: taskId } },
        create: { date, userId, taskIds: [taskId], minutes: 0 },
      }),
    ]);

    return c.json({ completed: true, completedAt: completion.completedAt.toISOString() });
  })

  // ─── PUT /progress/settings/started-at ───────────────────────────────────────
  .put("/progress/settings/started-at", zValidator("json", z.object({ startedAt: z.string() })), async (c) => {
    const userId = c.var.user.id;
    const { startedAt } = c.req.valid("json");

    await db.appSetting.upsert({
      where: { key_userId: { key: "startedAt", userId } },
      update: { value: startedAt },
      create: { key: "startedAt", userId, value: startedAt },
    });

    return c.json({ startedAt });
  });
