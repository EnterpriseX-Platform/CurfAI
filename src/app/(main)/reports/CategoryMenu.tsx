"use client";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A catalog filter (category, type) as one dropdown, so a long list of categories does not push the cards down the page. */
export function CategoryMenu({
  label, allLabel, categories, labels, active, hrefFor, icon,
}: {
  label: string;
  allLabel: string;
  categories: string[];
  /** Display names, for options whose key is not what a reader should see. */
  labels?: Record<string, string>;
  /** An element, not a component: this menu is rendered from server pages. */
  icon?: React.ReactNode;
  active: string | null;
  /** Server-built links, so the other filters are kept; null clears the category. */
  hrefFor: Record<string, string>;
}) {
  const router = useRouter();
  const options: Array<{ key: string; label: string; href: string }> = [
    { key: "", label: allLabel, href: hrefFor[""] },
    ...categories.map((c) => ({ key: c, label: labels?.[c] ?? c, href: hrefFor[c] })),
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" >
          {icon ?? <Tag className="mr-1.5 h-4 w-4" />} {active ? (labels?.[active] ?? active) : label} <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {options.map((o) => (
          <DropdownMenuItem key={o.key} onSelect={() => router.push(o.href)}>
            <Check className={"mr-2 h-4 w-4 " + ((active ?? "") === o.key ? "opacity-100" : "opacity-0")} /> {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
