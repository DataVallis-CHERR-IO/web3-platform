// robots.txt content per environment (TASK-035); served by app/robots.txt/route.ts.

/** AI crawlers named explicitly on non-prod environments. */
export const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  "Google-Extended", "PerplexityBot", "Perplexity-User", "CCBot", "Applebot-Extended", "Bytespider", "meta-externalagent",
] as const;

export function robotsBody(appEnv: string | undefined): string {
  if (appEnv === "prod") return "User-agent: *\nAllow: /\n";
  const named = AI_CRAWLERS.map((ua) => `User-agent: ${ua}\nDisallow: /\n`).join("\n");
  return `User-agent: *\nDisallow: /\n\n${named}`;
}
