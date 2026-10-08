import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { users, userAddresses, userRoles } from "@cherrio/db";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { fundingModeFromEnv } from "@/lib/funding/topup";
import { getImpact } from "@/lib/points/impact";
import { AccountClient } from "./AccountClient";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getSession();
  if (!session) {
    redirect(`/${locale}`);
  }

  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      anonymousDonations: users.anonymousDonations,
      locale: users.locale,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    redirect(`/${locale}`);
  }

  const addresses = await db
    .select({
      id: userAddresses.id,
      address: userAddresses.address,
      kind: userAddresses.kind,
      isPrimary: userAddresses.isPrimary,
    })
    .from(userAddresses)
    .where(eq(userAddresses.userId, session.userId));

  const roleRows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, session.userId));

  const initialUser = {
    ...user,
    roles: roleRows.map((r) => r.role),
    addresses,
  };

  // "Add money" for the CHERR.IO wallet (TASK-036, ADR-051).
  const chain = getChainConfig(parseAppEnv(process.env.APP_ENV ?? "local")).chain;
  const funding = { mode: fundingModeFromEnv(chain.testnet), networkName: chain.name };

  // Level badge (TASK-056b): the same ledger read as "My impact".
  const { level } = await getImpact(db, session.userId, 0);

  return <AccountClient initialUser={initialUser} funding={funding} level={level} />;
}
