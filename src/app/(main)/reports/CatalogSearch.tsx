"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";

export function CatalogSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const usp = new URLSearchParams(window.location.search);
        if (q) usp.set("q", q); else usp.delete("q");
        router.push(`/reports?${usp.toString()}`);
      }}
      className="relative max-w-sm flex-1"
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search reports…"
        className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm shadow-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </form>
  );
}
