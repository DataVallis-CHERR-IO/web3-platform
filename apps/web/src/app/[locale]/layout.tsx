import "../globals.css";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { Archivo, Archivo_Black, IBM_Plex_Mono } from "next/font/google";
import { routing } from "@/i18n/routing";
import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { ToastProvider } from "@cherrio/ui";
import { PrivyClientProvider } from "@/components/auth/PrivyClientProvider";
import { parseAppEnv } from "@cherrio/shared";

export const metadata: Metadata = {
  title: "CHERR.IO — Transparent charitable donations",
  description:
    "Give to people and charities you can check. Every donation is tracked on the blockchain.",
  icons: {
    icon: "/brand/favicon.svg",
    apple: "/brand/apple-touch-icon.png",
  },
  openGraph: {
    title: "CHERR.IO — Transparent charitable donations",
    description: "Give to people and charities you can check.",
    type: "website",
    images: [{ url: "/brand/og-placeholder.png", width: 1200, height: 630 }],
  },
};

// Self-hosted via next/font — no runtime requests to fonts.googleapis.com
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const archivoBold = Archivo_Black({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
  display: "swap",
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as "en")) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();
  const t = await getTranslations({ locale, namespace: "ui.nav" });

  // SSR cookie → data-theme attribute prevents flash
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get("theme")?.value;
  const dataTheme =
    themeCookie === "light" || themeCookie === "dark" ? themeCookie : undefined;

  const fontVars = [archivo.variable, archivoBold.variable, ibmPlexMono.variable].join(" ");
  const privyAppId = process.env.PRIVY_APP_ID;
  const appEnv = parseAppEnv(process.env.APP_ENV ?? "local");

  return (
    <html lang={locale} data-theme={dataTheme} className={fontVars}>
      <body>
        <a href="#main" className="ch-skip-link">
          {t("skipToContent")}
        </a>
        <NextIntlClientProvider messages={messages}>
          <PrivyClientProvider privyAppId={privyAppId} appEnv={appEnv} locale={locale}>
            <AppHeader />
            <main id="main">{children}</main>
            <AppFooter />
            <ToastProvider />
          </PrivyClientProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
