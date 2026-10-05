import { getTranslations } from "next-intl/server";

// Terms of Service and Privacy Policy (TASK-044, ADR-054). The text lives in
// next-intl (`legal.<doc>`); it is a draft under legal review, and the page
// says so. Version and date change together with the text.

export const LEGAL_VERSION = "0.1";
export const LEGAL_DATE = "2026-10-05";

interface Section {
  id: string;
  title: string;
  paragraphs: string[];
}

export async function LegalPage({ doc }: { doc: "terms" | "privacy" }) {
  const t = await getTranslations(`legal.${doc}`);
  const tLegal = await getTranslations("legal");
  const sections = t.raw("sections") as Section[];
  return (
    <div className="ch-container py-12 flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading">{t("title")}</h1>
        <p className="m-0 text-sm text-[var(--ink-muted)]">{tLegal("updated", { date: LEGAL_DATE })}</p>
        <p className="ch-notice m-0 max-w-[65ch]">{tLegal("draftNotice", { version: LEGAL_VERSION })}</p>
        <p className="m-0 max-w-[65ch]">{t("intro")}</p>
      </header>
      {sections.map((s) => (
        <section key={s.id} className="flex max-w-[65ch] flex-col gap-3" aria-labelledby={`${doc}-${s.id}`}>
          <h2 className="text-xl font-display uppercase text-[var(--ink)] m-0" id={`${doc}-${s.id}`}>{s.title}</h2>
          {s.paragraphs.map((p, i) => (
            <p key={i} className="m-0">{p}</p>
          ))}
        </section>
      ))}
    </div>
  );
}
