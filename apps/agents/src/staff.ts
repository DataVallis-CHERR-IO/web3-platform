/**
 * apps/agents/src/staff.ts — the staff agent's second factor (TASK-061e part 2).
 *
 * The staff agent passes the admin gate (role + authenticator code, ADR-056)
 * like a person: there is no bypass route. Its authenticator is a TOTP secret
 * kept as the GitHub secret AGENT_STAFF_TOTP_SECRET; this module computes the
 * codes (RFC 6238, the same parameters as apps/web/src/lib/auth/totp.ts:
 * SHA-1, 6 digits, 30 s) and drives the gate's pages.
 *
 * The web app is not imported (agents never import apps/web): the few lines of
 * TOTP are repeated here and pinned by the RFC 6238 test vectors.
 */
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright";

export const TOTP_PERIOD_SECONDS = 30;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The key as the enrolment page shows it ("ABCD EFGH …") or as stored (no spaces). */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  if (clean.length === 0) throw new Error("empty authenticator key");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("the authenticator key is not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP (RFC 4226); a TOTP code is HOTP(secret, time step). */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(secret: Buffer, nowMs: number): { code: string; step: number } {
  const step = timeStep(nowMs);
  return { code: hotp(secret, step), step };
}

/**
 * Each code works once (the app refuses a step at or below the last used one).
 * Returns how long to wait so the next code belongs to a later step than
 * `lastStep`, plus a second of margin against clock edges.
 */
export function msUntilNextStep(nowMs: number, lastStep: number): number {
  const next = (lastStep + 1) * TOTP_PERIOD_SECONDS * 1000;
  return Math.max(0, next - nowMs) + 1_000;
}

/** What an admin page shows the staff agent. */
export type GateState = "not-admin" | "enrol" | "verify" | "open";

/**
 * Texts from apps/web/messages/en.json: the gate's headings (admin.mfa.*) and
 * the admin menu (admin.nav.label), which the admin layout puts on every admin
 * page once the gate is passed.
 */
const ENROL_HEADING = "Set up your authenticator";
const VERIFY_HEADING = "Confirm it is you";
const ADMIN_MENU = "Admin menu";

const adminMenu = (page: Page) => page.getByRole("navigation", { name: ADMIN_MENU, exact: true });

/** Opens /en/admin and tells which screen it is. 404 means the user has no PLATFORM_ADMIN role. */
export async function adminGate(page: Page): Promise<GateState> {
  const res = await page.goto("/en/admin", { waitUntil: "domcontentloaded" });
  if (res?.status() === 404) return "not-admin";
  const screens: [Exclude<GateState, "not-admin">, ReturnType<typeof adminMenu>][] = [
    ["enrol", page.getByRole("heading", { name: ENROL_HEADING, exact: true })],
    ["verify", page.getByRole("heading", { name: VERIFY_HEADING, exact: true })],
    ["open", adminMenu(page)],
  ];
  const found = await Promise.any(
    screens.map(async ([state, locator]) => {
      await locator.first().waitFor({ state: "visible", timeout: 30_000 });
      return state;
    })
  ).catch(() => null);
  if (!found) throw new Error(`/en/admin answered ${res?.status() ?? "nothing"} and shows none of the admin headings`);
  return found;
}

/**
 * The code screen: types the current code and expects the admin menu.
 * `lastStep` is the step of a code already used in this session (enrolment), so
 * the same code is not sent twice.
 */
export async function passSecondFactor(page: Page, secret: Buffer, lastStep: number | null = null): Promise<number> {
  if (lastStep !== null) {
    const wait = msUntilNextStep(Date.now(), lastStep);
    if (wait > 0) await page.waitForTimeout(wait);
  }
  const { code, step } = totp(secret, Date.now());
  await page.getByLabel("6-digit code or a recovery code").fill(code);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await adminMenu(page).waitFor({ state: "visible", timeout: 30_000 });
  return step;
}

export interface Enrolled {
  /** Base32 without spaces: the value of AGENT_STAFF_TOTP_SECRET. */
  secret: string;
  recoveryCodes: string[];
  step: number;
}

/** Where the CLI keeps what the enrolment screen shows once (both files 0600). */
export interface EnrolmentFiles { secret: string; recovery: string }

/**
 * The enrolment screen, as a person would do it: show the key, read it, type
 * the code, read the ten recovery codes, continue. No screenshots here — the
 * screen shows the key.
 *
 * The key is written to its file **before** Confirm and the codes as soon as
 * they are read: once Confirm succeeds the factor is confirmed on the server,
 * and a later failure must not leave the key only in memory (review of #248).
 */
export async function enrolSecondFactor(page: Page, files: EnrolmentFiles): Promise<Enrolled> {
  // A click before React has hydrated the page does nothing (seen at 390 px in a local
  // check): click again until the key appears; no click once it is there.
  const key$ = page.getByTestId("mfa-secret");
  const show = page.getByRole("button", { name: "Show the QR code", exact: true });
  for (let attempt = 1; ; attempt++) {
    if (await key$.isVisible().catch(() => false)) break;
    if (await show.isVisible().catch(() => false)) await show.click({ timeout: 10_000 }).catch(() => undefined);
    if (await key$.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) break;
    if (attempt === 3) throw new Error("the enrolment screen shows no key after three clicks on “Show the QR code”");
  }
  const secret = (await key$.innerText()).replace(/\s+/g, "").toUpperCase();
  const key = base32Decode(secret);
  writeSecretFile(files.secret, secret);
  const { code, step } = totp(key, Date.now());
  await page.getByLabel("6-digit code from the app").fill(code);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  const items = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await items.first().waitFor({ state: "visible", timeout: 30_000 });
  const recoveryCodes = (await items.allInnerTexts()).map((c) => c.trim());
  writeSecretFile(files.recovery, `${recoveryCodes.join("\n")}\n`);
  if (recoveryCodes.length !== 10) throw new Error(`expected 10 recovery codes, the page shows ${recoveryCodes.length} (saved anyway)`);
  await page.getByRole("button", { name: "I saved them — continue" }).click();
  await adminMenu(page).waitFor({ state: "visible", timeout: 30_000 });
  return { secret, recoveryCodes, step };
}

/**
 * A file readable only by the owner: the folder is created (or tightened) to
 * 0700, an existing file is set to 0600 before the secret goes in, a new one
 * is created 0600. The text has no newline added (`gh secret set … < file`
 * stores it exactly).
 */
export function writeSecretFile(path: string, text: string) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, text, { mode: 0o600 });
}

/** Both files at once (tests; a re-save). */
export function saveEnrolment(enrolled: Pick<Enrolled, "secret" | "recoveryCodes">, paths: EnrolmentFiles) {
  writeSecretFile(paths.secret, enrolled.secret);
  writeSecretFile(paths.recovery, `${enrolled.recoveryCodes.join("\n")}\n`);
}
