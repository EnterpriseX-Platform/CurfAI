/**
 * Minimal `next/navigation` mock for Storybook.
 *
 * @storybook/nextjs mocked this module automatically; plain
 * @storybook/react-webpack5 has no Next.js awareness at all, so any
 * component that calls useRouter() (e.g. LocaleProvider, wrapped globally
 * around every story in preview.tsx) throws "invariant expected app router
 * to be mounted" outside a real Next.js App Router tree. Stories never
 * trigger navigation, so no-op stand-ins are enough.
 */
export function useRouter() {
  return {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
}

export function usePathname() {
  return "/";
}

export function useSearchParams() {
  return new URLSearchParams();
}

export function useParams() {
  return {};
}
