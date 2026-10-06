import type { Page } from "puppeteer";

/**
 * Forwards the caller's NextAuth session cookie into a Puppeteer page so the
 * headless viewer doesn't bounce to /login. Chrome enforces the cookie-prefix
 * spec at the CDP level: a `__Secure-`-named cookie MUST carry `secure: true`
 * or `Network.setCookies` rejects the whole call ("Invalid cookie fields").
 * NextAuth always uses that prefix once NEXTAUTH_URL is https (see
 * next-auth's defaultCookies()), which is every deployed environment, so
 * `secure` here is never optional.
 *
 * A Secure-flagged cookie is only ever sent back by Chrome over an https
 * connection or to a loopback host. If the Puppeteer target (internalBase())
 * isn't one of those, the cookie would still pass the CDP call above but get
 * silently dropped on navigation — rendering the export as a logged-out user
 * instead of failing loudly. That combination is rejected outright rather
 * than left to fail quietly.
 */
export async function setSessionCookie(page: Page, baseUrl: string, authCookie: string): Promise<void> {
  const [name, value] = authCookie.split("=", 2);
  if (!name || !value) return;

  const target = new URL(baseUrl);
  const isLoopback =
    target.hostname === "localhost" ||
    target.hostname === "127.0.0.1" ||
    target.hostname === "::1" ||
    target.hostname.endsWith(".localhost");
  const isSecureContext = target.protocol === "https:" || isLoopback;
  const secure = name.startsWith("__Secure-") || name.startsWith("__Host-");

  if (secure && !isSecureContext) {
    throw new Error(
      `Cannot forward session cookie "${name}" to insecure internal base URL ${baseUrl} — ` +
        "Chrome never returns a Secure cookie over plain HTTP to a non-loopback host. " +
        "Set INTERNAL_BASE_URL to an https:// address or a loopback host (127.0.0.1/localhost).",
    );
  }

  await page.setCookie({
    name,
    value: decodeURIComponent(value),
    domain: target.hostname,
    path: "/",
    secure,
    httpOnly: true,
    sameSite: "Lax",
  });
}
