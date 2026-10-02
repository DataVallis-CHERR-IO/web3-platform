"use client";
import * as React from "react";
import { useFormatter } from "next-intl";

/**
 * A moment in time in the viewer's own time zone (David, dev test 2026-10-02:
 * times showed in UTC). The server cannot know the viewer's zone, so the first
 * render (server and hydration) uses UTC and marks it; after mounting, the
 * browser's zone is used. Days that are not moments (the ECB rate date) are not
 * rendered with this component.
 */
export function LocalDateTime({ value, withTime = true }: { value: Date | string; withTime?: boolean }) {
  const format = useFormatter();
  const [timeZone, setTimeZone] = React.useState<string | null>(null);
  React.useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }, []);
  const date = typeof value === "string" ? new Date(value) : value;
  const text = format.dateTime(date, {
    dateStyle: withTime ? "medium" : "long",
    ...(withTime ? { timeStyle: "short" as const } : {}),
    timeZone: timeZone ?? "UTC",
  });
  return (
    <time dateTime={date.toISOString()}>
      {text}
      {timeZone === null && withTime ? " UTC" : null}
    </time>
  );
}
