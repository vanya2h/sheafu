import { Trans } from "@lingui/react/macro";
import { ArrowRightIcon, CaretDownIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { Phase } from "../data/types";
import { Ring } from "./Ring";
import { TaskRow } from "./TaskRow";

import { cn } from "~/lib/utils";

export type PhaseCardProps = React.ComponentProps<"div"> & {
  phase: Phase;
  curriculumId: string;
  index: number;
  completedTaskIds: ReadonlySet<string>;
};

export function PhaseCard({ phase, curriculumId, index, completedTaskIds, className, ...restProps }: PhaseCardProps) {
  const [open, setOpen] = useState(false);

  const completedCount = phase.tasks.filter((task) => completedTaskIds.has(task.id)).length;
  const totalMinutes = phase.tasks.reduce((acc, task) => acc + (task.estMinutes ?? 0), 0);
  const percent = phase.tasks.length === 0 ? 0 : Math.round((completedCount / phase.tasks.length) * 100);
  const panelId = `phase-panel-${curriculumId}-${phase.id}`;

  return (
    <div className={cn("border-b border-border last:border-b-0", className)} {...restProps}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "group w-full flex items-center gap-3 px-4 py-4 sm:gap-5 sm:px-6 sm:py-5 text-left transition-colors",
          "hover:bg-card-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/30",
          open ? "bg-card-active" : "",
        )}
      >
        <Ring percent={percent} size={36} stroke={2.5} />

        <span className="hidden sm:inline-block font-mono text-sm tabular-nums text-foreground/40 shrink-0">
          {formatIndex(index + 1)}
        </span>

        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold tracking-[-0.01em] text-foreground truncate">{phase.title}</div>
          <div className="mt-1 font-mono text-[11px] tracking-[0.04em] text-foreground/40">
            {completedCount}/{phase.tasks.length} <Trans>topics</Trans>
            {totalMinutes > 0 && ` · ${formatHours(totalMinutes)}`}
          </div>
        </div>

        <span className="hidden sm:inline-block font-mono text-sm tabular-nums text-foreground/50 shrink-0">
          {percent}%
        </span>

        <span
          className={cn(
            "shrink-0 grid place-items-center size-6 text-foreground/40 transition-[transform,color] duration-300",
            "group-hover:text-foreground",
            open && "rotate-90",
          )}
          aria-hidden
        >
          {open ? <CaretDownIcon size={14} weight="bold" /> : <ArrowRightIcon size={14} weight="bold" />}
        </span>
      </button>

      <div
        id={panelId}
        aria-hidden={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border px-3 py-3">
            {phase.tasks.map((task) => (
              <TaskRow key={task.id} task={task} curriculumId={curriculumId} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatIndex(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatHours(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}
