"use client";
import { useTranslations } from "next-intl";
import { Button } from "@cherrio/ui";
import { Link } from "@/i18n/routing";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";

/**
 * "Claim this organization" (TASK-017c): the KYB form prefilled with the listing.
 * Whether the visitor has a session is decided on the server (`loggedIn`);
 * without one the button opens the login.
 */
export function ClaimButton({ orgId, loggedIn }: { orgId: string; loggedIn: boolean }) {
  const t = useTranslations("marketCap.profile");
  const { isAuthenticated, isAvailable, isLoading, login } = useAppAuth();
  if (loggedIn || isAuthenticated) {
    return (
      <Link href={{ pathname: "/organizations/new", query: { claim: orgId } }} className="ch-btn ch-btn-primary self-start no-underline">
        {t("claim")}
      </Link>
    );
  }
  return (
    <Button variant="primary" className="self-start" onClick={login} disabled={!isAvailable || isLoading}>
      {t("claimLogin")}
    </Button>
  );
}
