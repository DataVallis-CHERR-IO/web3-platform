// robots.txt content per environment (TASK-035); served by app/robots.txt/route.ts.

/** AI crawlers named explicitly on non-prod environments. */
export const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  "Google-Extended", "PerplexityBot", "Perplexity-User", "CCBot", "Applebot-Extended", "Bytespider", "meta-externalagent",
] as const;

/**
 * Link-preview bots (TASK-059, David 2026-10-08): they read a shared page once to
 * show its title and image, and index nothing. Allowed on non-prod too, so a
 * campaign shared from dev shows its own preview. Search engines and AI
 * crawlers stay blocked there (and pages still send `X-Robots-Tag: noindex`).
 */
export const PREVIEW_BOTS = [
  "Twitterbot", "facebookexternalhit", "Facebot", "LinkedInBot", "WhatsApp", "TelegramBot", "Slackbot-LinkExpanding",
  "Discordbot",
] as const;

export function robotsBody(appEnv: string | undefined): string {
  if (appEnv === "prod") return "User-agent: *\nAllow: /\n";
  const previews = PREVIEW_BOTS.map((ua) => `User-agent: ${ua}\nAllow: /\n`).join("\n");
  const named = AI_CRAWLERS.map((ua) => `User-agent: ${ua}\nDisallow: /\n`).join("\n");
  return `${previews}\nUser-agent: *\nDisallow: /\n\n${named}`;
}
