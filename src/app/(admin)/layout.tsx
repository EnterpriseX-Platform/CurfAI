import { ThemeModeBoot } from "@/components/layout/ThemeModeBoot";

export const dynamic = "force-dynamic";

/** Same as the (main) group: stamp the user's light / dark mode before paint. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ThemeModeBoot />
      {children}
    </>
  );
}
