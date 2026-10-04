import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { ContractChangeError, type ContractChangeErrorCode } from "./changes";

// Shared frame of the admin console API (TASK-034a): PLATFORM_ADMIN re-read from
// the DB (404 for everyone else), origin check on writes, refusals → codes.
// The text of a code is the next-intl message `admin.contracts.errors.<code>`.

const STATUS: Record<ContractChangeErrorCode, number> = {
  not_configured: 503,
  validation_failed: 400,
  wrong_chain: 400,
  wrong_timelock: 400,
  foreign_target: 400,
  unknown_call: 400,
  operation_mismatch: 400,
  duplicate: 409,
  not_found: 404,
  already_closed: 409,
};

export async function handleContractsRoute(
  request: Request,
  write: boolean,
  action: (adminId: string) => Promise<unknown>
): Promise<Response> {
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  if (write && !verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await action(adminId));
  } catch (e) {
    if (!(e instanceof ContractChangeError)) throw e;
    if (e.code === "not_found") return new NextResponse(null, { status: 404 });
    return NextResponse.json({ error: e.code }, { status: STATUS[e.code] });
  }
}
