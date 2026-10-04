import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";

// One guard for the whole admin area (TASK-035). Anyone who is not a platform
// admin gets the same 404 as an unknown URL before any admin page renders.
// Every page keeps its own check too (defence in depth; a client-side
// navigation between admin pages does not re-run this layout).

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }
  return children;
}
