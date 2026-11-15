"use client";
/**
 * How this deployment signs people in, for the login pages (/login, the Executive view's sign-in): fetched once from
 * /api/sso-providers. `passwordLogin` is false when Keycloak is the only sign-in, so no page shows a password form;
 * `brokered` lists the social sign-ins Keycloak offers (Google, GitHub), which are started at Keycloak with a hint
 * instead of as separate NextAuth providers.
 */
import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";

export type SignInOptions = { loaded: boolean; providers: string[]; passwordLogin: boolean; brokered: string[]; companySso: boolean };

export function useSignInOptions(): SignInOptions {
  const [o, setO] = useState<SignInOptions>({ loaded: false, providers: [], passwordLogin: true, brokered: [], companySso: false });
  useEffect(() => {
    fetch("/api/sso-providers").then((r) => (r.ok ? r.json() : null))
      .then((j) => setO({ loaded: true, providers: j?.providers ?? [], passwordLogin: j?.passwordLogin !== false, brokered: j?.brokered ?? [], companySso: j?.companySso === true }))
      .catch(() => setO({ loaded: true, providers: [], passwordLogin: true, brokered: [], companySso: false }));
  }, []);
  return o;
}

/** Start a social sign-in: through Keycloak (with a hint that skips its own login page) when it brokers it, else NextAuth's own provider. */
export function startSocialSignIn(provider: "google" | "github", o: SignInOptions, callbackUrl: string) {
  if (o.brokered.includes(provider)) return signIn("keycloak", { callbackUrl }, { kc_idp_hint: provider });
  return signIn(provider, { callbackUrl });
}
