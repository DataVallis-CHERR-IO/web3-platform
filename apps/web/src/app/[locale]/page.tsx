import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Button } from "@cherrio/ui";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <HomeContent />;
}

function HomeContent() {
  const t = useTranslations("Index");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 text-center bg-background text-foreground">
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl text-primary">
        {t("title")}
      </h1>
      <p className="mt-4 text-lg text-muted-foreground max-w-md">
        {t("description")}
      </p>
      <div className="mt-6">
        <Button variant="default">{t("actionButton")}</Button>
      </div>
    </main>
  );
}
