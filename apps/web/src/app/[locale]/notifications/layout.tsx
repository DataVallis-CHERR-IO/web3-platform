import type { Metadata } from "next";

// Token pages from emails (TASK-033e): never indexed.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function NotificationsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
