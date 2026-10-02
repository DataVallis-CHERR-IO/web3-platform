import { describe, expect, it } from "vitest";
import { protectedPathHome } from "@/components/auth/PrivyClientProvider";

// After logout the browser leaves pages that need a session (David, dev test 2026-10-02).
describe("protectedPathHome", () => {
  it.each([
    ["/en/admin", "/en"],
    ["/en/admin/campaigns/01a0fd66-29e5-72f5-8f3f-3796c5d613e0", "/en"],
    ["/en/account", "/en"],
    ["/en/account/campaigns/new", "/en"],
    ["/en/organizations/new", "/en"],
  ])("%s → %s", (path, home) => expect(protectedPathHome(path)).toBe(home));

  it.each(["/en", "/en/campaigns", "/en/administration-fees", "/en/accounting", "/en/organizations"])(
    "%s stays",
    (path) => expect(protectedPathHome(path)).toBeNull()
  );
});
