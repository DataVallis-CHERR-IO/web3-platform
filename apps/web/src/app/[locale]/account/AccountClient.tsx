"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/routing";
import {
  Button,
  Address,
  StatusChip,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
  toast,
} from "@cherrio/ui";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useAppAuth, type AppUser } from "@/components/auth/PrivyClientProvider";
import { AddMoney } from "@/components/funding/AddMoney";
import type { FundingMode } from "@/lib/funding/topup";
import { LEVELS } from "@cherrio/shared/points";

export function AccountClient({
  initialUser,
  funding,
  level = 0,
}: {
  initialUser: AppUser;
  funding: { mode: FundingMode; networkName: string };
  /** Proof of Charity level (ADR-057), 0 = none yet. */
  level?: number;
}) {
  const t = useTranslations("account");
  const tAddress = useTranslations("ui.address");
  const tNotify = useTranslations("notifications");
  const tImpact = useTranslations("impact");
  const router = useRouter();
  const { user: authUser, refreshUser, linkWallet, unlinkWallet, logout, isAvailable } = useAppAuth();
  const { client: smartClient } = useSmartWallets();

  // The client user can come from an older response without `addresses`; never crash on it.
  const sessionUser = authUser ?? initialUser;
  const user = { ...sessionUser, addresses: sessionUser.addresses ?? initialUser.addresses ?? [] };
  // The CHERR.IO wallet's smart account receives card top-ups (TASK-036).
  const smartAccount = user.addresses.find((a) => a.kind === "SMART_ACCOUNT")?.address ?? null;

  const [displayName, setDisplayName] = React.useState(user.displayName);
  const [anonymousDonations, setAnonymousDonations] = React.useState(user.anonymousDonations);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // Sync state when user updates
  React.useEffect(() => {
    if (authUser) {
      setDisplayName(authUser.displayName);
      setAnonymousDonations(authUser.anonymousDonations);
    }
  }, [authUser]);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    const trimmed = displayName.trim();
    if (trimmed.length < 2 || trimmed.length > 40) {
      setSaveError(t("displayNameError"));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/auth/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: trimmed,
          anonymousDonations,
        }),
      });

      if (res.ok) {
        toast.success(t("saveSuccess"));
        await refreshUser();
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.message ?? t("saveChanges"));
      }
    } catch {
      setSaveError(t("saveChanges"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    try {
      const res = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (res.ok) {
        toast.success(t("deleteSuccess"));
        await logout();
        setDeleteOpen(false);
        router.push("/");
      } else {
        toast.error(t("deleteError"));
      }
    } catch {
      toast.error(t("deleteError"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="ch-container py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-10">
        {/* Header */}
        <div className="flex flex-col gap-2">
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">
            {t("title")}
          </h1>
          <p className="text-base text-[var(--ink-muted)]">
            {t("description")}
          </p>
        </div>

        {/* Profile Card */}
        <div className="ch-panel p-6 md:p-8 bg-[var(--surface-raised)] flex flex-col gap-6">
          <h2 className="text-xl font-display uppercase text-[var(--ink)]">
            {t("profileHeading")}
          </h2>

          <form onSubmit={handleSaveProfile} className="flex flex-col gap-5">
            <div className="ch-field">
              <label className="ch-label" htmlFor="displayName">
                {t("displayNameLabel")}
              </label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="ch-input"
                minLength={2}
                maxLength={40}
                required
              />
              <span className="ch-field-hint">
                {saveError ? (
                  <span className="text-[var(--cherry-500)] font-bold">{saveError}</span>
                ) : (
                  t("displayNameHint")
                )}
              </span>
            </div>

            <div className="ch-field">
              <label className="ch-label" htmlFor="email">
                {t("emailLabel")}
              </label>
              <input
                id="email"
                type="email"
                value={user.email ?? ""}
                readOnly
                disabled
                className="ch-input opacity-75 cursor-not-allowed bg-[var(--surface-sunken)]"
              />
              <span className="ch-field-hint">{t("emailHint")}</span>
            </div>

            <div className="flex items-start gap-3 pt-2">
              <input
                type="checkbox"
                id="anonymousDonations"
                checked={anonymousDonations}
                onChange={(e) => setAnonymousDonations(e.target.checked)}
                className="mt-1 h-5 w-5 border-2 border-[var(--ink)] accent-[var(--accent)] cursor-pointer"
              />
              <label htmlFor="anonymousDonations" className="flex flex-col cursor-pointer">
                <span className="font-bold text-sm text-[var(--ink)]">
                  {t("anonymousDonationsLabel")}
                </span>
                <span className="text-xs text-[var(--ink-muted)]">
                  {t("anonymousDonationsHint")}
                </span>
              </label>
            </div>

            <div className="pt-3">
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? t("loading") : t("saveChanges")}
              </Button>
            </div>
          </form>
        </div>

        {/* Linked Wallets Card */}
        <div className="ch-panel p-6 md:p-8 bg-[var(--surface-raised)] flex flex-col gap-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-display uppercase text-[var(--ink)]">
                {t("walletsHeading")}
              </h2>
              <p className="text-sm text-[var(--ink-muted)]">
                {t("walletsDescription")}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={linkWallet}
            >
              {t("linkWallet")}
            </Button>
          </div>

          <div className="flex flex-col gap-3">
            {/* Privy creates the wallet, then the smart account, seconds after the first
                login; WalletSync adds them here without a reload (TASK-011c follow-up). */}
            {isAvailable && user.addresses.length === 0 && (
              <p className="ch-notice m-0" role="status">{t("walletPreparing")}</p>
            )}
            {smartClient && user.addresses.some((a) => a.kind === "EMBEDDED") && !user.addresses.some((a) => a.kind === "SMART_ACCOUNT") && (
              <p className="ch-notice m-0" role="status">{t("smartPreparing")}</p>
            )}
            {user.addresses.map((addr, _i, all) => {
              const hasSmartAccount = all.some((a) => a.kind === "SMART_ACCOUNT");
              const canUnlink = !addr.isPrimary && addr.kind === "EXTERNAL";
              return (
                <div
                  key={addr.address}
                  className="p-4 border-2 border-[var(--ink)] bg-[var(--surface)] flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Address
                      address={addr.address}
                      copyLabel={tAddress("copy")}
                      copiedLabel={tAddress("copied")}
                    />
                    <StatusChip status={addr.kind === "EXTERNAL" ? "pending" : "verified"}>
                      {addr.kind === "SMART_ACCOUNT" ? t("smartBadge") : addr.kind === "EMBEDDED" ? t("embeddedBadge") : t("externalBadge")}
                    </StatusChip>
                    {addr.isPrimary && (
                      <span className="ch-mono text-xs font-bold uppercase bg-[var(--ink)] text-[var(--surface)] px-2 py-0.5 border border-[var(--ink)]">
                        {t("primaryBadge")}
                      </span>
                    )}
                    {addr.kind === "SMART_ACCOUNT" && <p className="m-0 w-full text-sm">{t("smartHint")}</p>}
                    {addr.kind === "EMBEDDED" && hasSmartAccount && <p className="m-0 w-full text-sm">{t("signerHint")}</p>}
                  </div>

                  {canUnlink && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-xs self-end sm:self-auto"
                      onClick={() => unlinkWallet(addr.address)}
                    >
                      {t("unlinkWallet")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {smartAccount && (
            <AddMoney address={smartAccount as `0x${string}`} mode={funding.mode} networkName={funding.networkName} />
          )}
        </div>

        {/* Organisation */}
        <div className="ch-panel p-6 md:p-8 bg-[var(--surface-raised)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-display uppercase text-[var(--ink)]">
              {t("organization.linkHeading")}
            </h2>
            <p className="text-sm text-[var(--ink-muted)]">
              {t("organization.linkDescription")}
            </p>
          </div>
          <Link href="/account/organization" className="ch-btn no-underline">
            {t("organization.linkButton")}
          </Link>
        </div>

        {/* My impact (TASK-056b, ADR-057) */}
        <div className="ch-panel p-6 md:p-8 bg-[var(--surface-raised)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className="ch-eyebrow">
              {level > 0
                ? tImpact("levelName", { level, name: tImpact(`levels.${LEVELS.find((l) => l.level === level)?.key ?? "supporter"}`) })
                : tImpact("noLevel")}
            </span>
            <h2 className="text-xl font-display uppercase text-[var(--ink)]">
              {tImpact("accountLinkHeading")}
            </h2>
            <p className="text-sm text-[var(--ink-muted)]">
              {tImpact("accountLinkDescription")}
            </p>
          </div>
          <Link href="/account/impact" className="ch-btn no-underline">
            {tImpact("accountLinkButton")}
          </Link>
        </div>

        {/* Email notifications (TASK-033e) */}
        <div className="ch-panel p-6 md:p-8 bg-[var(--surface-raised)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-display uppercase text-[var(--ink)]">
              {tNotify("accountLinkHeading")}
            </h2>
            <p className="text-sm text-[var(--ink-muted)]">
              {tNotify("accountLinkDescription")}
            </p>
          </div>
          <Link href="/account/notifications" className="ch-btn no-underline">
            {tNotify("accountLinkButton")}
          </Link>
        </div>

        {/* Danger Zone: Delete Account */}
        <div className="ch-panel p-6 md:p-8 border-red-500 bg-[var(--surface-raised)] flex flex-col gap-4">
          <h2 className="text-xl font-display uppercase text-red-600">
            {t("dangerZone")}
          </h2>
          <p className="text-sm text-[var(--ink-muted)]">
            {t("dangerDesc")}
          </p>

          <div>
            <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" className="border-2 border-red-600 text-red-600 hover:bg-red-50 dark:hover:bg-red-950 font-bold">
                  {t("deleteButton")}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle className="text-red-600">
                    {t("dialogTitle")}
                  </DialogTitle>
                  <DialogDescription className="flex flex-col gap-3 pt-2 text-sm text-[var(--ink)]">
                    <span>{t("dialogDesc")}</span>
                    <span className="p-3 bg-[var(--surface-sunken)] border border-[var(--line-soft)] text-xs text-[var(--ink-muted)]">
                      {t("dialogBlockchainNote")}
                    </span>
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2 sm:gap-0 pt-4">
                  <DialogClose asChild>
                    <Button variant="ghost">{t("dialogCancel")}</Button>
                  </DialogClose>
                  <Button
                    type="button"
                    variant="primary"
                    className="bg-red-600 text-white hover:bg-red-700 border-red-600"
                    disabled={deleting}
                    onClick={handleDeleteAccount}
                  >
                    {deleting ? t("deleting") : t("dialogConfirm")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>
    </div>
  );
}
