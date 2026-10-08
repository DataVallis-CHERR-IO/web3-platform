import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { openApiDocument } from "@/lib/api/openapi";
import { siteOrigin } from "@/lib/api/v1";

// TASK-018b: human reference of the public API, rendered from the same
// OpenAPI document the API serves (one source, no drift).

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "apiDocs" });
  return { title: t("metaTitle"), description: t("intro") };
}

interface Param {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema: { type?: string; enum?: readonly (string | null)[] };
}

export default async function ApiDocsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("apiDocs");
  const origin = siteOrigin();
  const doc = openApiDocument(origin);
  const base = doc.servers[0]!.url;
  const paths = Object.entries(doc.paths) as unknown as [string, { get: { summary: string; parameters: Param[]; responses: Record<string, { description: string }> } }][];

  return (
    <article className="ch-container py-12 flex flex-col gap-10 max-w-[90ch]">
      <header className="flex flex-col gap-4">
        <h1 className="ch-section-heading">{t("title")}</h1>
        <p className="m-0 text-lg leading-7">{t("intro")}</p>
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
          <dt className="font-bold">{t("baseUrl")}</dt>
          <dd className="m-0 ch-mono break-all">{base}</dd>
          <dt className="font-bold">{t("format")}</dt>
          <dd className="m-0">{t("formatBody")}</dd>
          <dt className="font-bold">{t("limits")}</dt>
          <dd className="m-0">{t("limitsBody")}</dd>
          <dt className="font-bold">{t("openapi")}</dt>
          <dd className="m-0">
            <a href={`${base}/openapi.json`} className="ch-proof ch-mono break-all">
              {`${base}/openapi.json`}
            </a>
          </dd>
        </dl>
      </header>

      {paths.map(([path, { get }]) => (
        <section key={path} className="flex flex-col gap-4" aria-labelledby={`ep-${path.replace(/\W+/g, "-")}`}>
          <h2 id={`ep-${path.replace(/\W+/g, "-")}`} className="m-0 text-xl font-bold">
            <span className="ch-mono">GET {path}</span>
          </h2>
          <p className="m-0">{get.summary}</p>
          {get.parameters.length > 0 && (
            <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("parametersOf", { path })}>
              <table className="ch-ledger">
                <thead>
                  <tr>
                    <th scope="col">{t("parameter")}</th>
                    <th scope="col">{t("where")}</th>
                    <th scope="col">{t("description")}</th>
                  </tr>
                </thead>
                <tbody>
                  {get.parameters.map((p) => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td>{p.in}</td>
                      <td className="whitespace-normal">
                        {p.description}
                        {p.schema.enum && <span className="block ch-ledger-muted">{p.schema.enum.filter(Boolean).join(" · ")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="m-0 text-sm text-[var(--ink-muted)]">
            {t("responses")}: {Object.entries(get.responses).map(([code, r]) => `${code} ${r.description}`).join(" · ")}
          </p>
          <pre className="m-0 ch-panel p-4 ch-mono text-sm whitespace-pre-wrap break-all">
            <code>{`curl ${base}${path.replace("{id}", "<id>").replace("{slug}", "<slug>")}`}</code>
          </pre>
        </section>
      ))}
    </article>
  );
}
