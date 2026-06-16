import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { Link } from "react-router";
import { Pending, useModelStore } from "rxfy-react";
import { listCurriculums } from "../data/curriculum";
import type { CurriculumDef } from "../data/types";
import { useCurriculaData } from "../hooks/useCurriculaData";
import { useProgressData } from "../hooks/useProgressData";
import { useTheme } from "../hooks/useTheme";
import { GRADIENT_PRESETS } from "../lib/gradient";
import { CustomCurriculumModel } from "../lib/models/curriculum";
import { getCurriculumLinks } from "../lib/routes";
import { Inset } from "./layout/Inset";
import { PageBody } from "./layout/PageBody";
import { Section } from "./layout/Section";
import { SectionHeader } from "./layout/SectionHeader";
import { AnimatedText } from "./AnimatedText";
import { GradientBackground } from "./GradientBg";
import { CreatePersonalProgramCard, ProgramCard } from "./ProgramCard";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useLocale } from "~app/hooks/useLocale";

function calcCurriculumProgress(curriculum: CurriculumDef, completedSet: ReadonlySet<string>) {
  let totalWeight = 0;
  let doneWeight = 0;
  for (const phase of curriculum.phases) {
    for (const task of phase.tasks) {
      const w = task.estMinutes ?? 60;
      totalWeight += w;
      if (completedSet.has(task.id)) doneWeight += w;
    }
  }
  return totalWeight === 0 ? 0 : Math.round((doneWeight / totalWeight) * 100);
}

const CELL_BORDERS = cn("border-b border-border", "sm:max-lg:odd:border-r", "lg:not-nth-[3n]:border-r");

export function Dashboard() {
  const { t } = useLingui();
  const locale = useLocale();
  const { data$: progress$ } = useProgressData();
  const { data$: curricula$ } = useCurriculaData();
  const customStore = useModelStore(CustomCurriculumModel);
  const { theme } = useTheme();
  const builtIn = useMemo(() => listCurriculums(locale), [locale]);

  return (
    <PageBody>
      <Section className="relative isolate overflow-hidden">
        <GradientBackground preset={theme === "dark" ? GRADIENT_PRESETS.heroDark : GRADIENT_PRESETS.heroLight} />
        <Inset className="relative flex flex-col items-center justify-center text-center py-24 sm:py-32">
          <AnimatedText
            as="h1"
            text={t`Learn Everything`}
            split="char"
            animation="animate-soft-blur-in"
            stagger={25}
            className="text-4xl sm:text-5xl lg:text-6xl font-semibold text-foreground max-w-3xl font-display"
          />
          <AnimatedText
            as="p"
            text={t`Turn any topic into a focused study plan. Track tasks, build skills, and stay consistent.`}
            split="word"
            animation="animate-word-rise"
            stagger={70}
            delay={500}
            className="mt-6 text-lg sm:text-xl lg:text-2xl text-foreground/70 max-w-2xl"
          />
          <Button
            size="lg"
            variant="default"
            render={<Link to={getCurriculumLinks().new} />}
            className="mt-10 active:scale-[0.98] transition-all animate-fade-rise [animation-delay:1500ms]"
          >
            <Trans>New Program</Trans>
          </Button>
        </Inset>
      </Section>
      <Pending value$={curricula$}>
        {({ curricula: customIds }) => {
          const custom: CurriculumDef[] = [];
          for (const id of customIds) {
            const entity = customStore.getValue(id);
            if (entity) custom.push(entity);
          }
          const allCurriculums = [...builtIn, ...custom];
          return (
            <Pending value$={progress$}>
              {(progress) => (
                <ProgramsSection allCurriculums={allCurriculums} completedSet={new Set(progress.completions)} />
              )}
            </Pending>
          );
        }}
      </Pending>
    </PageBody>
  );
}

function ProgramsSection({
  allCurriculums,
  completedSet,
}: {
  allCurriculums: CurriculumDef[];
  completedSet: ReadonlySet<string>;
}) {
  return (
    <Section>
      <SectionHeader>
        <h2 className="text-2xl font-semibold text-foreground">
          <Trans>Programs</Trans>
        </h2>
      </SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {allCurriculums.map((curriculum) => (
          <ProgramCard
            key={curriculum.id}
            curriculum={curriculum}
            progress={calcCurriculumProgress(curriculum, completedSet)}
            className={CELL_BORDERS}
          />
        ))}
        <CreatePersonalProgramCard className={CELL_BORDERS} />
      </div>
    </Section>
  );
}
