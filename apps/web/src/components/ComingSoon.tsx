import { Link } from "@/i18n/routing";
import { useTranslations } from "next-intl";

interface ComingSoonProps {
  titleKey: string;
  descKey: string;
}

export function ComingSoon({ titleKey, descKey }: ComingSoonProps) {
  const t = useTranslations("comingSoon");

  return (
    <div className="ch-container py-16">
      <div className="ch-card p-8 md:p-12 max-w-2xl mx-auto flex flex-col items-start gap-6 bg-[var(--surface-raised)]">
        <div className="flex flex-col gap-2">
          <span className="ch-mono text-xs uppercase tracking-wider text-[var(--ink-muted)]">
            {t("title")}
          </span>
          <h1 className="text-3xl md:text-4xl font-display uppercase tracking-tight text-[var(--ink)]">
            {t(titleKey)}
          </h1>
        </div>

        <p className="text-base md:text-lg text-[var(--ink-muted)] leading-relaxed">
          {t(descKey)}
        </p>

        <div className="pt-4">
          <Link href="/" className="ch-btn ch-btn-primary shadow-hard text-inherit">
            {t("backHome")}
          </Link>
        </div>
      </div>
    </div>
  );
}
