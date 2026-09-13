import { useEffect, useRef } from "react";

/**
 * Wires a custom modal/dialog with:
 *   - Escape key → onClose
 *   - Focus trap (Tab cycles within the modal, Shift+Tab too)
 *   - Initial focus on the first focusable element
 *   - Restores focus to the previously-focused element on close
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   useEscapeAndFocusTrap(open, onClose, ref);
 *   return <div ref={ref} role="dialog" aria-modal="true">...</div>;
 */
export function useEscapeAndFocusTrap(
  open: boolean,
  onClose: () => void,
  containerRef: React.RefObject<HTMLElement>
): void {
  // Keep onClose in a ref so it's never stale inside the effect but also
  // never causes the effect to re-run (which would re-steal focus on every
  // keystroke when the parent passes an inline arrow function as onClose).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusableSelectors = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function getFocusable(): HTMLElement[] {
      return Array.from(container!.querySelectorAll<HTMLElement>(focusableSelectors)).filter(
        (el) => el.offsetParent !== null
      );
    }

    // Initial focus on first focusable, or container itself.
    setTimeout(() => {
      const focusables = getFocusable();
      (focusables[0] ?? container).focus();
    }, 0);

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = getFocusable();
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, containerRef]); // onClose intentionally omitted — accessed via ref
}
