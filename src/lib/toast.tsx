"use client";
/**
 * Minimal useToast() hook + ToastHost component. Not as featureful as
 * shadcn's toaster example but smaller and fits our needs.
 */
import * as React from "react";
import {
  Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport,
} from "@/components/ui/toast";

type ToastKind = "default" | "success" | "destructive";
type ToastItem = {
  id: string;
  title?: string;
  description?: string;
  variant?: ToastKind;
};

type Ctx = {
  push: (t: Omit<ToastItem, "id">) => void;
};

const ToastCtx = React.createContext<Ctx | null>(null);

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const push = React.useCallback((t: Omit<ToastItem, "id">) => {
    const id = Math.random().toString(36).slice(2);
    setItems((s) => [...s, { id, ...t }]);
  }, []);
  const remove = React.useCallback((id: string) => {
    setItems((s) => s.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      <ToastProvider swipeDirection="right">
        {children}
        {items.map((t) => (
          <Toast
            key={t.id}
            variant={t.variant}
            // Radix's 5s default is easy to miss on a destructive toast that
            // carries an actionable message (e.g. an upgrade URL) rather
            // than a one-word confirmation — give those more time on screen.
            duration={t.variant === "destructive" ? 9000 : 5000}
            onOpenChange={(open) => { if (!open) remove(t.id); }}
          >
            <div className="grid gap-0.5">
              {t.title && <ToastTitle>{t.title}</ToastTitle>}
              {t.description && <ToastDescription>{t.description}</ToastDescription>}
            </div>
            <ToastClose />
          </Toast>
        ))}
        <ToastViewport />
      </ToastProvider>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastHost>");
  return ctx;
}
