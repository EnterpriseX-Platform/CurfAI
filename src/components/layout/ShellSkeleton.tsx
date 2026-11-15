/**
 * The console shell's stand-in while a route loads (the loading.tsx files):
 * the same columns AppShell draws at each width — the 64px rail from md, the
 * 248px sections column from lg — so the page doesn't jump when it arrives.
 * AppShell isn't a shared layout (every page renders its own), so each
 * route's fallback draws this.
 */
export function ShellSkeleton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen bg-background md:grid md:grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[64px_248px_minmax(0,1fr)]"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      <div className="hidden flex-col items-center gap-1.5 border-r border-sidebar-border bg-sidebar py-3.5 md:flex">
        {Array.from({ length: 7 }).map((_, i) => <div key={i} className="skeleton h-11 w-11 rounded-xl" />)}
      </div>
      <div className="hidden border-r border-sidebar-border bg-sidebar px-3 py-3.5 lg:block">
        <div className="skeleton mb-4 h-12 w-full rounded-md" />
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton mb-2 h-7 w-full rounded-md" />)}
      </div>
      {children}
    </div>
  );
}
