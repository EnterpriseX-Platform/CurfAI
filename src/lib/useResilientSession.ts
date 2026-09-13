"use client";
/**
 * Wraps next-auth's useSession() to work around a real bug in its v4
 * client: once a session fetch fails once (CLIENT_FETCH_ERROR — a dev
 * restart, a rolling deploy, a brief network blip), next-auth caches
 * `_session = null` internally and every subsequent auto-refetch trigger
 * (window focus, poll, storage) silently no-ops forever. Only a full
 * page reload (which resets that cache) recovers. Users experienced
 * this as "half the sidebar just disappeared" with no error shown.
 *
 * Every page that renders this hook only does so after a server-side
 * session check (see requireUser()/getServerSession() in lib/auth.ts),
 * so a null session here is virtually always that stuck-cache bug, not
 * a real logout. We self-heal via next-auth's exported getSession(),
 * which performs its own unconditional fetch and bypasses that stuck
 * cache entirely, retried with backoff. If every retry still comes back
 * empty, we surface a visible toast instead of silently rendering a
 * degraded "viewer" view with no explanation.
 *
 * `role`/`email`/`user` below are read straight off useSession() — no
 * mount gate. There used to be one, forcing a "viewer" placeholder until
 * after mount, because role wasn't known on the server. It now is:
 * RootLayout fetches the session server-side and hands it to
 * <SessionProvider session=...> (see app/providers.tsx), so useSession()
 * already returns the real role on the server render AND the first
 * client paint — there's no flip between them left to guard against.
 * `hydrated` still exists to gate the self-heal retry effect below (its
 * body only ever runs client-side anyway, but the flag keeps the retry
 * loop from starting before the component has actually mounted).
 */
import { useEffect, useRef, useState } from "react";
import { getSession, useSession } from "next-auth/react";
import { useToast } from "@/lib/toast";

const RETRY_DELAYS_MS = [1500, 4000, 9000];

export function useResilientSession() {
  const { data: session, status } = useSession();
  const [hydrated, setHydrated] = useState(false);
  const [recovered, setRecovered] = useState<any>(null);
  // Context value from useToast() isn't reference-stable across renders, so
  // it can't sit in the effect's dependency array without causing spurious
  // restarts. A ref keeps the effect's own deps limited to the session
  // signals that should actually trigger a (re)start.
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => { setHydrated(true); }, []);

  useEffect(() => {
    if (!hydrated || status === "loading" || session || recovered) return;
    let cancelled = false;
    (async () => {
      for (const delay of RETRY_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (cancelled) return;
        const fresh = await getSession().catch(() => null);
        if (fresh?.user) {
          if (!cancelled) setRecovered(fresh);
          return;
        }
      }
      if (!cancelled) {
        toastRef.current.push({
          variant: "destructive",
          title: "Connection lost",
          description: "We couldn't refresh your session. Reload the page to restore your view.",
        });
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, status, session, recovered]);

  const effectiveSession: any = session ?? recovered;
  const user = effectiveSession?.user ?? null;
  const role: string = user?.role ?? "viewer";
  const email: string | null = user?.email ?? null;

  return { hydrated, role, email, user, session: effectiveSession as typeof session };
}
