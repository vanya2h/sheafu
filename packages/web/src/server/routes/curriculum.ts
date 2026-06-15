import { zValidator } from "@hono/zod-validator";
import type { Prisma } from "@prisma/client-generated";
import { Hono } from "hono";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import {
  COMPLEXITY_LEVELS,
  OutlinePhaseSchema,
  parseCurriculumOutline,
  parsePhase,
  PhaseSchema,
  SkillSchema,
} from "../../data/types";
import { generateGradient, GradientCoverSchema } from "../../lib/gradient";
import { LOCALES } from "../../lib/i18n";
import { parseJSON } from "../../lib/json";
import { db } from "../db";
import { getProfileContext } from "../lib/profileContext";
import { streamLLM } from "../lib/streamLLM";
import type { AuthEnv } from "../middleware/requireAuth";

const GENERATE_SYSTEM = `You generate interview-prep curriculums from job postings.

The user will provide a job posting's text content. Analyze it and produce a JSON object matching this TypeScript type:

\`\`\`ts
type CurriculumDef = {
  id: string;          // kebab-case slug, e.g. "stripe-senior-frontend"
  name: string;        // "Company — Role Prep"
  description: string; // one-sentence summary
  phases: Phase[];     // 4-7 phases
  skills: Skill[];     // one per phase
};
type Phase = {
  id: string;          // kebab-case, prefixed per domain (e.g. "fe-", "sys-", "algo-")
  title: string;
  subtitle: string;    // one sentence of guidance
  tasks: Task[];       // 4-8 tasks per phase
};
type Task = {
  id: string;          // kebab-case, prefixed with short phase abbrev
  title: string;       // short topic phrase, e.g. "REST API pagination, auth patterns, rate limiting" — NOT full sentences like "Read and annotate X"
  estMinutes: number;  // realistic: reading 60-120, building 120-240, review 30-60
};
type Skill = {
  id: string;
  name: string;        // MUST be a specific technology/domain, e.g. "Java Core Fundamentals", "React Native Basics", "Kubernetes Operations" — NEVER generic labels like "Interview Readiness" or "Job Ready"
  description: string;
  unlockedBy: { phaseId: string }; // references a phase id
};
\`\`\`

Rules:
- Tailor phases to the SPECIFIC job requirements. If the job needs Kubernetes, include a Kubernetes phase. If it's frontend, make system design frontend-flavored.
- Task titles must be short topic phrases (under 10 words), not full sentences. Good: "React reconciliation and fiber internals". Bad: "Read and annotate a comprehensive guide to React reconciliation".
- All IDs must be unique and kebab-case.
- Always include a "mock interview + practice" phase and a "company research" phase at the end.
- Skills must name a concrete technical domain mastered (e.g. "TypeScript Proficiency", "System Design Fundamentals", "React Native Basics"). Never use generic process labels like "Interview Readiness", "Mock Interview Complete", or "Job Ready".
- Output ONLY valid JSON — no markdown fences, no commentary.
- If the user provides feedback, incorporate it into the revised curriculum.`;

const OUTLINE_SYSTEM = `You generate interview-prep curriculum outlines from job postings.

The user will provide a job posting's text content and a complexity mode. Analyze the posting and produce a JSON object matching this TypeScript type:

\`\`\`ts
type CurriculumOutline = {
  id: string;          // kebab-case slug, e.g. "stripe-senior-frontend"
  name: string;        // "Company — Role Prep"
  description: string; // one-sentence summary
  phases: PhaseOutline[];  // count depends on complexity mode (see rules)
  skills: Skill[];     // one skill unlocked per phase
};
type PhaseOutline = {
  id: string;          // kebab-case, prefixed per domain (e.g. "fe-", "sys-", "algo-", "co-")
  title: string;
  subtitle: string;    // one sentence describing what this phase prepares the candidate for
};
type Skill = {
  id: string;
  name: string;        // MUST be a specific technology/domain, e.g. "Java Core Fundamentals", "React Native Basics", "Kubernetes Operations" — NEVER generic labels like "Interview Readiness" or "Job Ready"
  description: string;
  unlockedBy: { phaseId: string }; // references a phase id
};
\`\`\`

Rules:
- Tailor phases to the SPECIFIC job requirements.
- Do NOT include tasks — only phase structure and skills.
- All IDs must be unique and kebab-case.
- Always end with a "mock interview + practice" phase and a "company research" phase.
- Skills must name a concrete technical domain mastered (e.g. "TypeScript Proficiency", "System Design Fundamentals", "React Native Basics"). Never use generic process labels like "Interview Readiness", "Mock Interview Complete", or "Job Ready".
- Output ONLY valid JSON — no markdown fences, no commentary.
- If the user provides feedback, incorporate it into the revised outline.

Complexity mode rules (the mode is specified in the user message):
- easy: 2-3 phases total. Pick only the highest-impact topics. Skip anything supplementary or advanced.
- medium: 3-6 phases. Cover core requirements plus key supporting topics.
- deep: 5-9 phases. Comprehensive coverage including advanced topics, system design depth, and exploratory areas.`;

const PHASE_SYSTEM = `You generate the tasks for one specific phase of an interview-prep curriculum.

The user provides the job posting, the full curriculum outline, any already-generated phases (for context), the complexity mode, and which phase index to generate.

Produce a JSON object for JUST that one phase:

\`\`\`ts
type Phase = {
  id: string;         // match the id from the outline exactly
  title: string;      // match the title from the outline exactly
  subtitle: string;   // match the subtitle from the outline exactly
  tasks: Task[];      // count depends on complexity mode (see rules)
};
type Task = {
  id: string;         // kebab-case, use the phase id as a prefix (e.g. "fe-basics-read-docs")
  title: string;      // short topic phrase, e.g. "REST API pagination, auth patterns, rate limiting" — NOT full sentences like "Read and annotate X"
  estMinutes: number; // realistic: reading 60-120, building 120-240, review 30-60
};
\`\`\`

Rules:
- Copy the phase id, title, subtitle exactly from the outline.
- Task titles must be short topic phrases (under 10 words), not full sentences. Good: "React reconciliation and fiber internals". Bad: "Read and annotate a comprehensive guide to React reconciliation".
- Do not duplicate tasks that appear in already-generated phases.
- Output ONLY valid JSON — no markdown fences, no commentary.
- If the user provides feedback, incorporate it.

Complexity mode rules (the mode is specified in the user message):
- easy: 3-5 tasks. Prefer reading and watching (30-90 min each). No open-ended builds or research.
- medium: 5-7 tasks. Mix of reading and structured hands-on exercises (45-150 min each).
- deep: 6-8 tasks. Include reading, guided builds, and open-ended research or project challenges (60-240 min each).`;

const PDF_FALLBACK_HINT =
  "Couldn't read the job posting from this URL — many sites render content with JavaScript and aren't readable as plain HTML. Try opening the page in your browser, saving it as a PDF, and using the PDF upload option instead.";

function cleanHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15000);
}

async function extractFromUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CurriculumBot/1.0)" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = cleanHtml(html);
    return text.length < 300 ? null : text;
  } catch {
    return null;
  }
}

const generateSchema = z.object({
  url: z.url(),
  feedback: z.string().optional(),
  locale: z.enum(LOCALES).optional(),
});

const generateFromPdfSchema = z.object({
  file: z.instanceof(File),
  feedback: z.string().optional(),
  locale: z.enum(LOCALES).optional(),
});

const extractSchema = z.object({ url: z.url() });
const extractPdfSchema = z.object({ file: z.instanceof(File) });

const generateOutlineSchema = z.object({
  textContent: z.string().min(100),
  complexity: z.enum(COMPLEXITY_LEVELS).optional(),
  feedback: z.string().optional(),
  locale: z.enum(LOCALES).optional(),
});

const generatePhaseSchema = z.object({
  textContent: z.string().min(100),
  outline: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    phases: z.array(OutlinePhaseSchema).min(1),
    skills: z.array(SkillSchema).optional(),
  }),
  phaseIndex: z.number().int().min(0),
  completedPhases: z.array(PhaseSchema).optional(),
  complexity: z.enum(COMPLEXITY_LEVELS).optional(),
  feedback: z.string().optional(),
  locale: z.enum(LOCALES).optional(),
});

const SelectionsSchema = z.object({
  selectedPhaseIds: z.array(z.string()),
  deselectedTaskIds: z.array(z.string()),
  currentPhaseIdx: z.number().int().min(0).optional(),
});

const draftCreateSchema = z
  .object({
    inputMode: z.enum(["url", "pdf"]),
    url: z.url().optional(),
    textContent: z.string().min(100).optional(),
    complexity: z.enum(COMPLEXITY_LEVELS),
    cover: GradientCoverSchema.optional(),
  })
  .refine((d) => (d.inputMode === "url" ? !!d.url : !!d.textContent), {
    message: "url required for URL mode; textContent required for PDF mode",
  });

const draftUpdateSchema = z.object({
  selections: SelectionsSchema.optional(),
  complexity: z.enum(COMPLEXITY_LEVELS).optional(),
});

const draftStreamSchema = z.object({
  feedback: z.string().optional(),
  locale: z.enum(LOCALES).optional(),
});

const draftStreamPhaseSchema = z.object({
  phaseId: z.string(),
  feedback: z.string().optional(),
  locale: z.enum(LOCALES).optional(),
});

const saveSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  jobUrl: z.url().optional(),
  phases: z.array(PhaseSchema).min(1),
  skills: z.array(SkillSchema).optional(),
  complexity: z.enum(COMPLEXITY_LEVELS).optional(),
});

export const curriculumRoute = new Hono<AuthEnv>()
  .post("/curriculums/extract", zValidator("json", extractSchema), async (c) => {
    const { url } = c.req.valid("json");
    const text = await extractFromUrl(url);
    if (!text) return c.json({ error: PDF_FALLBACK_HINT }, 400);
    return c.json({ text });
  })
  .post("/curriculums/extract-pdf", zValidator("form", extractPdfSchema), async (c) => {
    const { file } = c.req.valid("form");
    if (file.type !== "application/pdf") return c.json({ error: "File must be a PDF" }, 400);

    let text: string;
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const pdf = await getDocumentProxy(buffer);
      const { text: raw } = await extractText(pdf, { mergePages: true });
      text = raw.replace(/\s+/g, " ").trim().slice(0, 15000);
    } catch (err) {
      console.error("[curriculum/extract-pdf] parse error:", err);
      return c.json({ error: "Failed to parse PDF" }, 400);
    }

    if (!text) return c.json({ error: "PDF contained no extractable text" }, 400);
    return c.json({ text });
  })
  .post("/curriculums/generate-outline", zValidator("json", generateOutlineSchema), async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    const { textContent, complexity, feedback, locale } = c.req.valid("json");
    const profile = await getProfileContext(c.var.user.id);

    const userMessage = [
      `Job posting:\n\n${textContent}`,
      `\n\nComplexity: ${complexity ?? "medium"}`,
      feedback ? `\n\nFeedback on previous outline:\n${feedback}` : "",
    ].join("");

    return streamLLM({ userId: c.var.user.id, system: OUTLINE_SYSTEM, userMessage, locale, maxTokens: 2000, profile });
  })
  .post("/curriculums/generate-phase", zValidator("json", generatePhaseSchema), async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    const { textContent, outline, phaseIndex, completedPhases, complexity, feedback, locale } = c.req.valid("json");

    if (phaseIndex >= outline.phases.length) return c.json({ error: "Invalid phase index" }, 400);

    const phase = outline.phases[phaseIndex]!;
    const completedSection =
      completedPhases && completedPhases.length > 0
        ? `\nAlready generated phases (for context — do not duplicate tasks):\n${JSON.stringify(completedPhases, null, 2)}\n`
        : "";

    const userMessage = [
      `Job posting:\n\n${textContent}`,
      `\n\nComplexity: ${complexity ?? "medium"}`,
      `\n\nCurriculum outline:\n${JSON.stringify(outline, null, 2)}`,
      completedSection,
      `\n\nGenerate tasks for phase ${phaseIndex + 1} of ${outline.phases.length}: "${phase.title}" (id: "${phase.id}")`,
      feedback ? `\n\nFeedback to incorporate: ${feedback}` : "",
    ].join("");

    const profile = await getProfileContext(c.var.user.id);
    return streamLLM({ userId: c.var.user.id, system: PHASE_SYSTEM, userMessage, locale, maxTokens: 1500, profile });
  })
  .post("/curriculums/generate", zValidator("json", generateSchema), async (c) => {
    const { url, feedback, locale } = c.req.valid("json");
    if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 500);

    let pageText: string;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CurriculumBot/1.0)" },
      });
      if (!res.ok) return c.json({ error: PDF_FALLBACK_HINT }, 400);
      pageText = await res.text();
    } catch {
      return c.json({ error: PDF_FALLBACK_HINT }, 400);
    }

    const textContent = cleanHtml(pageText);
    if (textContent.length < 300) return c.json({ error: PDF_FALLBACK_HINT }, 400);

    const userMessage = feedback
      ? `Job posting:\n\n${textContent}\n\nUser feedback on previous generation:\n${feedback}`
      : `Job posting:\n\n${textContent}`;

    const profile = await getProfileContext(c.var.user.id);
    return streamLLM({ userId: c.var.user.id, system: GENERATE_SYSTEM, userMessage, locale, maxTokens: 4000, profile });
  })
  .post("/curriculums/generate-from-pdf", zValidator("form", generateFromPdfSchema), async (c) => {
    const { file, feedback, locale } = c.req.valid("form");
    if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    if (file.type !== "application/pdf") return c.json({ error: "File must be a PDF" }, 400);

    let textContent: string;
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const pdf = await getDocumentProxy(buffer);
      const { text } = await extractText(pdf, { mergePages: true });
      textContent = text.replace(/\s+/g, " ").trim().slice(0, 15000);
    } catch (err) {
      console.error("[curriculum/generate-from-pdf] parse error:", err);
      return c.json({ error: "Failed to parse PDF" }, 400);
    }

    if (!textContent) return c.json({ error: "PDF contained no extractable text" }, 400);

    const userMessage = feedback
      ? `Job posting:\n\n${textContent}\n\nUser feedback on previous generation:\n${feedback}`
      : `Job posting:\n\n${textContent}`;

    const profile = await getProfileContext(c.var.user.id);
    return streamLLM({ userId: c.var.user.id, system: GENERATE_SYSTEM, userMessage, locale, maxTokens: 4000, profile });
  })
  .post("/curriculums", zValidator("json", saveSchema), async (c) => {
    const userId = c.get("user").id;
    const { name, description, jobUrl, phases, skills, complexity } = c.req.valid("json");

    const record = await db.customCurriculum.create({
      data: {
        userId,
        name,
        description,
        jobUrl,
        cover: generateGradient() as Prisma.InputJsonValue,
        phases: phases as Prisma.InputJsonValue,
        skills: skills ? (skills as Prisma.InputJsonValue) : undefined,
        complexity: complexity ?? "deep",
      },
    });

    return c.json({ id: record.id });
  })
  .delete("/curriculums/:id", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");

    await db.customCurriculum.deleteMany({ where: { id, userId } });
    return c.json({ ok: true });
  })
  .get("/curriculums/drafts", async (c) => {
    const userId = c.get("user").id;
    const drafts = await db.customCurriculum.findMany({
      where: { userId, status: "draft" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        jobUrl: true,
        cover: true,
        complexity: true,
        outline: true,
        updatedAt: true,
        createdAt: true,
      },
    });
    return c.json({ drafts });
  })
  .post("/curriculums/drafts", zValidator("json", draftCreateSchema), async (c) => {
    const userId = c.get("user").id;
    const { inputMode, url, textContent, complexity, cover } = c.req.valid("json");

    const draft = await db.customCurriculum.create({
      data: {
        userId,
        status: "draft",
        complexity,
        cover: (cover ?? generateGradient()) as Prisma.InputJsonValue,
        jobUrl: inputMode === "url" ? url : null,
        textContent: inputMode === "pdf" ? (textContent ?? null) : null,
      },
    });

    return c.json({ id: draft.id });
  })
  .patch("/curriculums/drafts/:id", zValidator("json", draftUpdateSchema), async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const updates = c.req.valid("json");

    const draft = await db.customCurriculum.findFirst({ where: { id, userId, status: "draft" } });
    if (!draft) return c.json({ error: "Draft not found" }, 404);

    await db.customCurriculum.update({
      where: { id },
      data: {
        ...(updates.complexity ? { complexity: updates.complexity } : {}),
        ...(updates.selections ? { selections: updates.selections as Prisma.InputJsonValue } : {}),
      },
    });
    return c.json({ ok: true });
  })
  .delete("/curriculums/drafts/:id", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");

    await db.customCurriculum.deleteMany({ where: { id, userId, status: "draft" } });
    return c.json({ ok: true });
  })
  .get("/curriculums/published", async (c) => {
    const userId = c.get("user").id;
    const records = await db.customCurriculum.findMany({
      where: { userId, status: "published" },
      select: {
        id: true,
        name: true,
        description: true,
        complexity: true,
        cover: true,
        outline: true,
        status: true,
      },
    });
    return c.json({ curricula: records });
  })
  .post("/curriculums/drafts/:id/extract", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");

    const draft = await db.customCurriculum.findFirst({ where: { id, userId, status: "draft" } });
    if (!draft) return c.json({ error: "Draft not found" }, 404);
    if (draft.textContent) return c.json({ ok: true, alreadyExtracted: true });
    if (!draft.jobUrl) return c.json({ error: "Draft has no jobUrl to extract from" }, 400);

    const text = await extractFromUrl(draft.jobUrl);
    if (!text) return c.json({ error: PDF_FALLBACK_HINT }, 400);

    await db.customCurriculum.update({ where: { id }, data: { textContent: text } });
    return c.json({ ok: true });
  })
  .post("/curriculums/drafts/:id/generate-outline", zValidator("json", draftStreamSchema), async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const { feedback, locale } = c.req.valid("json");

    const draft = await db.customCurriculum.findFirst({ where: { id, userId, status: "draft" } });
    if (!draft) return c.json({ error: "Draft not found" }, 404);
    if (!draft.textContent) return c.json({ error: "No extracted text yet" }, 400);

    const userMessage = [
      `Job posting:\n\n${draft.textContent}`,
      `\n\nComplexity: ${draft.complexity}`,
      feedback ? `\n\nFeedback on previous outline:\n${feedback}` : "",
    ].join("");

    const profile = await getProfileContext(userId);
    return streamLLM({
      userId,
      system: OUTLINE_SYSTEM,
      userMessage,
      locale,
      maxTokens: 2000,
      profile,
      onComplete: async (fullText) => {
        try {
          const parsed = parseCurriculumOutline(parseJSON<unknown>(fullText));
          if (!parsed) {
            console.error("[draft generate-outline] failed to parse");
            return;
          }
          await db.customCurriculum.update({
            where: { id },
            data: {
              outline: parsed as unknown as Prisma.InputJsonValue,
              name: parsed.name,
              description: parsed.description,
              generatedPhases: {} as Prisma.InputJsonValue,
              selections: {
                selectedPhaseIds: parsed.phases.map((p) => p.id),
                deselectedTaskIds: [],
                currentPhaseIdx: 0,
              } as Prisma.InputJsonValue,
            },
          });
        } catch (err) {
          console.error("[draft generate-outline] persist error:", err);
        }
      },
    });
  })
  .post("/curriculums/drafts/:id/generate-phase", zValidator("json", draftStreamPhaseSchema), async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const { phaseId, feedback, locale } = c.req.valid("json");

    const draft = await db.customCurriculum.findFirst({ where: { id, userId, status: "draft" } });
    if (!draft) return c.json({ error: "Draft not found" }, 404);
    if (!draft.textContent) return c.json({ error: "No extracted text yet" }, 400);

    const outline = parseCurriculumOutline(draft.outline);
    if (!outline) return c.json({ error: "Invalid or missing outline" }, 400);

    const phaseIndex = outline.phases.findIndex((p) => p.id === phaseId);
    if (phaseIndex === -1) return c.json({ error: "Phase not in outline" }, 400);
    const phase = outline.phases[phaseIndex]!;

    const generatedPhases = (draft.generatedPhases ?? {}) as Record<string, unknown>;
    const completedPhases = outline.phases
      .filter((p) => p.id !== phaseId && generatedPhases[p.id])
      .map((p) => generatedPhases[p.id]);

    const userMessage = [
      `Job posting:\n\n${draft.textContent}`,
      `\n\nComplexity: ${draft.complexity}`,
      `\n\nCurriculum outline:\n${JSON.stringify(outline, null, 2)}`,
      completedPhases.length > 0
        ? `\nAlready generated phases (for context — do not duplicate tasks):\n${JSON.stringify(completedPhases, null, 2)}\n`
        : "",
      `\n\nGenerate tasks for phase ${phaseIndex + 1} of ${outline.phases.length}: "${phase.title}" (id: "${phaseId}")`,
      feedback ? `\n\nFeedback to incorporate: ${feedback}` : "",
    ].join("");

    const profile = await getProfileContext(userId);
    return streamLLM({
      userId,
      system: PHASE_SYSTEM,
      userMessage,
      locale,
      maxTokens: 1500,
      profile,
      onComplete: async (fullText) => {
        try {
          const parsed = parsePhase(parseJSON<unknown>(fullText));
          if (!parsed) {
            console.error("[draft generate-phase] failed to parse");
            return;
          }
          const next = { ...generatedPhases, [phaseId]: parsed };
          await db.customCurriculum.update({
            where: { id },
            data: { generatedPhases: next as Prisma.InputJsonValue },
          });
        } catch (err) {
          console.error("[draft generate-phase] persist error:", err);
        }
      },
    });
  })
  .post("/curriculums/drafts/:id/publish", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");

    const draft = await db.customCurriculum.findFirst({ where: { id, userId, status: "draft" } });
    if (!draft) return c.json({ error: "Draft not found" }, 404);

    const outline = parseCurriculumOutline(draft.outline);
    if (!outline) return c.json({ error: "Outline missing or invalid" }, 400);

    const selections = SelectionsSchema.safeParse(draft.selections);
    if (!selections.success) return c.json({ error: "Selections missing or invalid" }, 400);
    const { selectedPhaseIds, deselectedTaskIds } = selections.data;

    const generatedPhases = (draft.generatedPhases ?? {}) as Record<string, unknown>;
    const finalPhases = outline.phases
      .filter((p) => selectedPhaseIds.includes(p.id))
      .map((p) => {
        const generated = parsePhase(generatedPhases[p.id]);
        if (!generated) return null;
        return { ...generated, tasks: generated.tasks.filter((t) => !deselectedTaskIds.includes(t.id)) };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null && p.tasks.length > 0);

    if (finalPhases.length === 0) return c.json({ error: "No generated phases to publish" }, 400);

    await db.customCurriculum.update({
      where: { id },
      data: {
        status: "published",
        name: outline.name,
        description: outline.description,
        phases: finalPhases as unknown as Prisma.InputJsonValue,
        skills: outline.skills ? (outline.skills as unknown as Prisma.InputJsonValue) : undefined,
      },
    });

    return c.json({ id });
  });
