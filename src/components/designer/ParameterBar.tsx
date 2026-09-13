"use client";
import { useState } from "react";
import type { Parameter } from "@/lib/reporting/schema";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export function ParameterBar({
  parameters, initial, onApply,
}: {
  parameters: Parameter[];
  initial?: Record<string, unknown>;
  onApply: (values: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const p of parameters) out[p.name] = initial?.[p.name] ?? p.default ?? "";
    return out;
  });

  if (parameters.length === 0) return null;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onApply(values); }}
      className="flex flex-wrap items-end gap-3 border-b border-border bg-muted/30 p-3"
    >
      {parameters.map((p) => (
        <div key={p.name} className="grid gap-1">
          <Label htmlFor={p.name}>{p.label}</Label>
          <Input
            id={p.name}
            type={p.type === "date" ? "date" : p.type === "number" ? "number" : "text"}
            value={String(values[p.name] ?? "")}
            onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
            className="h-8 w-40"
            required={p.required}
          />
        </div>
      ))}
      <Button type="submit" size="sm">Run</Button>
    </form>
  );
}
