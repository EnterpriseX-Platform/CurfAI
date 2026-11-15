"use client";
import { useRef } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, LayoutGrid, Plus, Table2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type NewMenuLabels = {
  create: string;
  blank: string; blankDesc: string;
  dashboard: string; dashboardDesc: string;
  importFile: string; importDesc: string;
};

/** The "New" split: a blank report (the same POST the old button made), a dashboard, or an import. */
export function NewMenu({ labels }: { labels: NewMenuLabels }) {
  const router = useRouter();
  const blankForm = useRef<HTMLFormElement>(null);
  const items = [
    { icon: Table2, title: labels.blank, desc: labels.blankDesc, run: () => blankForm.current?.requestSubmit() },
    { icon: LayoutGrid, title: labels.dashboard, desc: labels.dashboardDesc, run: () => router.push("/dashboards/manage") },
    { icon: Upload, title: labels.importFile, desc: labels.importDesc, run: () => router.push("/reports/import") },
  ];
  return (
    <>
      {/* Outside the menu: the menu unmounts on select, which would cancel a submit made from inside it. */}
      <form ref={blankForm} action="/api/reports" method="POST" className="hidden" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            <Plus className="mr-1.5 h-4 w-4" /> {labels.create} <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {items.map((it) => (
            <DropdownMenuItem key={it.title} onSelect={(e) => { e.preventDefault(); it.run(); }} className="items-start gap-2.5 py-2">
              <it.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="flex flex-col">
                <span className="text-sm font-medium">{it.title}</span>
                <span className="text-xs text-muted-foreground">{it.desc}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
