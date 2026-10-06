/**
 * Admin route-group counterpart to (main)/loading.tsx — same rationale
 * (AppShell isn't a shared layout, see (admin)/layout.tsx's own comment),
 * same generic sidebar + PageHeader + block-grid skeleton so it fits the
 * many differently-shaped /admin/* pages without being tailored to one.
 */
export default function Loading() {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[224px_1fr]" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>

      {/* Sidebar stand-in */}
      <div className="hidden border-r border-sidebar-border bg-sidebar p-3 lg:block">
        <div className="skeleton mb-4 h-8 w-full rounded-md" />
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="skeleton mb-2 h-7 w-full rounded-md" />
        ))}
      </div>

      <div className="mx-auto w-full max-w-[1264px] px-8 pb-12 pt-7">
        {/* PageHeader stand-in */}
        <div className="mb-6 flex items-end justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="skeleton h-8 w-72 max-w-full rounded-sm" />
            <div className="skeleton mt-2.5 h-3 w-56 rounded-sm" />
          </div>
          <div className="skeleton h-8 w-24 shrink-0 rounded-md" />
        </div>

        {/* Generic content blocks */}
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex h-28 flex-col gap-2.5 rounded-report border border-border bg-card px-[18px] py-3.5">
              <div className="skeleton h-2.5 w-20 rounded-sm" />
              <div className="skeleton h-6 w-28 rounded-sm" />
              <div className="skeleton mt-auto h-2.5 w-24 rounded-sm" />
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-border bg-card p-5">
          <div className="skeleton h-4 w-32 rounded-sm" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="mt-4 flex items-center gap-4 border-t border-border pt-3 first:mt-3 first:border-t-0 first:pt-0">
              <div className="skeleton h-3 w-1/3 rounded-sm" />
              <div className="skeleton h-3 w-1/5 rounded-sm" />
              <div className="skeleton ml-auto h-3 w-16 rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
