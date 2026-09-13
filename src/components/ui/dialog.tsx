"use client";
/**
 * Dialog primitive — design-system polish over Radix Dialog.
 *
 * Conventions this primitive enforces:
 *
 *   - Default max-width is sm/md (448px). Override via `className` for the
 *     occasional wide form (Suggest, Generate). Default WAS max-w-4xl
 *     which produced uncomfortably-wide modals across the app.
 *   - Internal padding flow is structured: <DialogHeader> + <DialogBody>
 *     + <DialogFooter>. Each has its own padding so content never sits
 *     flush with the rounded corners.
 *   - Header gets an optional <DialogIcon> slot — small accented circle
 *     with a Lucide icon. Anchors the dialog visually.
 *   - Backdrop is bg-black/60 + backdrop-blur-md. Stronger than Radix's
 *     default so the focus actually lands on the dialog.
 *   - Mount + unmount animations via data-state. Subtle scale + fade —
 *     200ms total. Skips entirely when prefers-reduced-motion is set.
 *   - Close button is a 32px touch target with hover ring, not a 12px
 *     near-invisible X.
 *
 * Backwards-compat: the old API (DialogHeader, DialogTitle, DialogDescription,
 * DialogContent) keeps working. New consumers should reach for DialogBody +
 * DialogFooter to get the right spacing for free.
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 backdrop-blur-md",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
      "motion-reduce:animate-none motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // bg via inline style as a defensive fallback — some Tailwind builds
      // strip the class if the var isn't loaded yet (SSR + first paint).
      // A dialog is a surface (--card), not the page ground (--background).
      style={{ backgroundColor: "hsl(var(--card, 0 0% 100%))" }}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
        "overflow-hidden rounded-xl border border-border shadow-2xl shadow-black/20",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
        "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
        "data-[state=open]:slide-in-from-bottom-2",
        "motion-reduce:animate-none",
        // Prevent overflowing the viewport on tall forms — same fix that
        // was applied to ~10 custom modals; baking it into the primitive
        // stops the bug class from re-emerging through shadcn consumers.
        "max-h-[90vh] overflow-y-auto",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        aria-label="Close"
        className={cn(
          "absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors",
          "hover:bg-muted hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/**
 * DialogHeader — slot for the title + description + optional icon.
 * Renders with a bottom border so the body has visual separation. The
 * icon slot is opt-in; when absent the title sits left-aligned as before.
 */
export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex items-start gap-3 border-b border-border px-5 py-4 pr-12",
      // pr-12 leaves room for the close button so the title never overlaps it
      className,
    )}
    {...props}
  />
);

/**
 * DialogIcon — accented circle to anchor the header. Pass a Lucide icon
 * as the child (rendered at h-4 w-4 inside an h-9 w-9 disc). Tone follows
 * the variant prop; defaults to brand primary.
 */
export const DialogIcon = ({
  variant = "primary",
  children,
}: {
  variant?: "primary" | "success" | "warning" | "danger" | "neutral";
  children: React.ReactNode;
}) => {
  const tone: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10     text-success",
    warning: "bg-warning/10     text-warning",
    danger:  "bg-destructive/10 text-destructive",
    neutral: "bg-muted          text-muted-foreground",
  };
  return (
    <span className={cn(
      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1 ring-border",
      tone[variant],
    )}>
      {children}
    </span>
  );
};

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-base font-semibold leading-tight tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("mt-1 text-xs leading-relaxed text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

/**
 * DialogBody — main content slot with the right padding. Use this instead
 * of dropping form bits straight inside DialogContent (which has zero
 * padding by design — header/body/footer carry their own).
 */
export const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("space-y-4 px-5 py-4", className)} {...props} />
);

/**
 * DialogFooter — action row at the bottom. Right-aligned by default;
 * pass `className="justify-between"` for a left-aligned secondary action.
 * Muted background so it visually anchors the primary CTA.
 */
export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3",
      className,
    )}
    {...props}
  />
);
