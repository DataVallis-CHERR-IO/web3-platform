import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requirePlatformAdminRole } from "@/lib/auth/session";
import { getMfaStatus, hasValidMfa, readMfaCookie } from "@/lib/auth/admin-mfa";
import { getDb } from "@/lib/db";
import { AdminMfaGate } from "@/components/admin/AdminMfaGate";
import { AdminNav } from "@/components/admin/AdminNav";
import { demoCampaignsAllowed } from "@/lib/demo/create";

// One guard for the whole admin area (TASK-035). Anyone who is not a platform
// admin gets the same 404 as an unknown URL before any admin page renders.
// An admin without a valid second factor (ADR-056, TASK-049) sees the
// enrolment or code screen instead of the page. Every page keeps its own
// requireRole("PLATFORM_ADMIN") check too (role + second factor; defence in
// depth — a client-side navigation between admin pages does not re-run this layout).

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  let userId: string;
  try {
    userId = (await requirePlatformAdminRole()).userId;
  } catch {
    notFound();
  }
  const db = getDb();
  const { status } = await getMfaStatus(db, userId);
  if (status !== "confirmed") return <AdminMfaGate mode="enrol" />;
  if (!(await hasValidMfa(db, userId, await readMfaCookie()))) return <AdminMfaGate mode="verify" />;
  // TASK-021: one side menu for every admin page (same frame as the account area).
  return (
    <div className="ch-container ch-account ch-admin">
      <AdminNav showDemo={demoCampaignsAllowed()} />
      <div className="ch-account-main">{children}</div>
    </div>
  );
}
