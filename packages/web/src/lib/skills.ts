import type { CurriculumDef, Skill } from "../data/types";

export type UnlockedSkill = {
  skill: Skill;
  curriculumId: string;
  curriculumName: string;
  unlockedAt: Date;
};

export type GetCompletedAt = (taskId: string) => string | undefined;

function resolveSkillUnlock(
  skill: Skill,
  curriculum: CurriculumDef,
  getCompletedAt: GetCompletedAt,
): UnlockedSkill | null {
  const phase = curriculum.phases.find((p) => p.id === skill.unlockedBy.phaseId);
  if (!phase) return null;

  const tasks = phase.tasks;
  if (tasks.length === 0) return null;

  const timestamps: string[] = [];
  for (const task of tasks) {
    const ts = getCompletedAt(task.id);
    if (!ts) return null;
    timestamps.push(ts);
  }

  const sorted = timestamps.map((ts) => new Date(ts)).sort((a, b) => b.getTime() - a.getTime());
  const unlockedAt = sorted[0];
  if (!unlockedAt) return null;

  return { skill, curriculumId: curriculum.id, curriculumName: curriculum.name, unlockedAt };
}

export function computeUnlockedSkills(getCompletedAt: GetCompletedAt, curriculums: CurriculumDef[]): UnlockedSkill[] {
  return curriculums
    .flatMap((curriculum) =>
      (curriculum.skills ?? [])
        .map((skill) => resolveSkillUnlock(skill, curriculum, getCompletedAt))
        .filter((s): s is UnlockedSkill => s !== null),
    )
    .sort((a, b) => b.unlockedAt.getTime() - a.unlockedAt.getTime());
}
