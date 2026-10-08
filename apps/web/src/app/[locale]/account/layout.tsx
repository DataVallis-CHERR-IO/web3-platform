import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { LEVELS } from "@cherrio/shared/points";
import { userAddresses, userRoles, users } from "@cherrio/db";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getImpact } from "@/lib/points/impact";
import { AccountNav } from "@/components/account/AccountNav";

// The account area's frame (TASK-058): side menu + page. Logged out, the page
// itself redirects home (each page keeps its own check); here we render it bare.

export const dynamic = "force-dynamic";

const short = (a: string) => (a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) return children;
  const db = getDb();
  const [[user], addresses, roles, impact, t, tImpact] = await Promise.all([
    db.select({ displayName: users.displayName }).from(users).where(eq(users.id, session.userId)).limit(1),
    db.select({ address: userAddresses.address, isPrimary: userAddresses.isPrimary }).from(userAddresses).where(eq(userAddresses.userId, session.userId)),
    db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, session.userId)),
    getImpact(db, session.userId, 0),
    getTranslations("ui.nav"),
    getTranslations("impact"),
  ]);
  if (!user) return children;
  const primary = addresses.find((a) => a.isPrimary) ?? addresses[0];
  const label = user.displayName || (primary ? short(primary.address) : t("account"));
  const rule = LEVELS.find((l) => l.level === impact.level);
  const levelText = rule ? tImpact("levelName", { level: rule.level, name: tImpact(`levels.${rule.key}`) }) : tImpact("noLevel");

  return (
    <div className="ch-container ch-account">
      <AccountNav label={label} levelText={levelText} isAdmin={roles.some((r) => r.role === "PLATFORM_ADMIN")} />
      <div className="ch-account-main">{children}</div>
    </div>
  );
}
