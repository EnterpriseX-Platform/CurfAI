import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The page header every top-level surface shares: an optional eyebrow, the
 * 32px title, a one-line mono description, and the actions that belong to
 * the page on the right — the same shape the Reports, Operate and Knowledge
 * pages set. One component rather than a copy per page, so a change to the
 * type scale lands everywhere at once.
 */
export function PageHeader({
  eyebrow, title, description, actions, className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      {/* The text block yields before the actions wrap — up to a floor.
          `min-w-[14rem]` (not 0) is what makes the floor real: a flex item
          with no min-width will shrink to nothing before ever wrapping its
          sibling, which is why an early version of this header let its
          action buttons run off the edge of a narrow (375px) viewport
          instead of dropping to their own row underneath. Once the title
          column hits its floor, flex-wrap does the rest. */}
      <div className="min-w-[14rem] flex-1 basis-[24rem]">
        {eyebrow && (
          <div className="text-xs font-medium uppercase tracking-[.04em] text-muted-foreground">{eyebrow}</div>
        )}
        <h1 className="break-words text-[32px] font-semibold leading-[1.15] tracking-[-.015em] text-foreground [text-wrap:balance]">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-3xl break-words font-mono text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {/* Not shrink-0 — same reasoning as the title block's min-width
          floor: a shrink-0 flex item keeps its full natural width even
          once wrapped onto its own row, so several actions together can
          run the last one off the edge of a narrow viewport instead of
          wrapping. Letting the row shrink lets its own flex-wrap do the
          rest, across two or three short rows. */}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
