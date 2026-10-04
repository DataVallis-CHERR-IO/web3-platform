import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { type Address, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { GET as listRoute, POST as scheduleRoute } from "@/app/api/admin/contracts/changes/route";
import { POST as executedRoute } from "@/app/api/admin/contracts/changes/[id]/executed/route";
import { POST as cancelledRoute } from "@/app/api/admin/contracts/changes/[id]/cancelled/route";
import { consoleContracts, ContractChangeError, recordScheduled, verifyScheduled, type ScheduledInput } from "@/lib/contracts/changes";
import { encodeSetter, paramSpec } from "@/lib/contracts/config-params";
import { operationId, ZERO_BYTES32 } from "@/lib/contracts/timelock";
import { cleanUp, createUser, ORIGIN, type TestUser } from "./helpers/organizations";

// TASK-034a: the record API of the contract admin console. The server accepts a
// scheduled timelock operation only when every call is a known PlatformConfig
// setter for this environment and the operation id matches its arguments.

const { contractChanges, auditLog } = schema;
// Tests run with APP_ENV=local, which has no deployment: the schedule route answers
// not_configured there, so recording is tested on the library with the dev (Amoy) contracts.
process.env.APP_ENV ??= "local";
const contracts = consoleContracts("dev")!;
const txHash = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const salt = (): Hex => `0x${randomBytes(32).toString("hex")}`;

let admin: TestUser;
let other: TestUser;
const ids: string[] = [];

function scheduled(overrides: Partial<ScheduledInput> = {}): ScheduledInput {
  const targets: Address[] = [contracts.platformConfig, contracts.platformConfig];
  const payloads = [encodeSetter(paramSpec("voteWindow"), 3600n), encodeSetter(paramSpec("quorumBps"), 2500n)];
  const s = salt();
  const base = {
    chainId: contracts.chainId,
    timelock: contracts.timelock,
    targets,
    payloads,
    predecessor: ZERO_BYTES32,
    salt: s,
    operationId: operationId({ targets, payloads, predecessor: ZERO_BYTES32, salt: s }),
    delaySeconds: 300,
    previous: { voteWindow: "86400", quorumBps: "5000" },
    txHash: txHash(),
  };
  return { ...base, ...overrides };
}

type Result = { status: number; json: Record<string, unknown> | null };
async function send(
  route: (req: Request, ctx: never) => Promise<Response>,
  user: TestUser | null,
  body: unknown,
  { method = "POST", id, origin = ORIGIN }: { method?: string; id?: string; origin?: string } = {}
): Promise<Result> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (user) headers.cookie = user.cookie;
  const res = await route(
    new Request(`${ORIGIN}/api/admin/contracts/changes`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) }),
    { params: Promise.resolve({ id: id ?? "" }) } as never
  );
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

beforeAll(async () => {
  admin = await createUser({ admin: true });
  other = await createUser();
});

afterAll(async () => {
  const db = getDb();
  if (ids.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.entityId, ids));
    await db.delete(contractChanges).where(inArray(contractChanges.id, ids));
  }
  await cleanUp();
});

describe("verifyScheduled", () => {
  const refuse = (input: ScheduledInput) => {
    try {
      verifyScheduled(input, contracts);
      return null;
    } catch (e) {
      return e instanceof ContractChangeError ? e.code : String(e);
    }
  };

  it("accepts the console's own operation and summarises it from the payloads", () => {
    expect(verifyScheduled(scheduled(), contracts)).toEqual([
      { key: "voteWindow", from: "86400", to: "3600" },
      { key: "quorumBps", from: "5000", to: "2500" },
    ]);
  });

  it("refuses another chain, another timelock or a target other than PlatformConfig", () => {
    expect(refuse(scheduled({ chainId: 137 }))).toBe("wrong_chain");
    expect(refuse(scheduled({ timelock: contracts.platformConfig }))).toBe("wrong_timelock");
    const input = scheduled();
    input.targets = [contracts.timelock, contracts.platformConfig];
    expect(refuse(input)).toBe("foreign_target");
  });

  it("refuses unknown calls, out-of-bounds values and the same parameter twice", () => {
    const grant: Hex = `0x2f2ff15d${"0".repeat(128)}`; // grantRole(bytes32,address)
    expect(refuse(scheduled({ payloads: [grant, encodeSetter(paramSpec("quorumBps"), 2500n)] }))).toBe("unknown_call");
    const tooShort: Hex = "0x9e33a38e000000000000000000000000000000000000000000000000000000000000003c"; // setVoteWindow(60)
    expect(refuse(scheduled({ payloads: [tooShort, encodeSetter(paramSpec("quorumBps"), 2500n)] }))).toBe("unknown_call");
    const twice = encodeSetter(paramSpec("quorumBps"), 2500n);
    expect(refuse(scheduled({ payloads: [twice, twice] }))).toBe("unknown_call");
  });

  it("refuses an operation id that does not match the arguments", () => {
    expect(refuse(scheduled({ operationId: `0x${"ab".repeat(32)}` }))).toBe("operation_mismatch");
    // Same id, but the payload was swapped after hashing.
    const input = scheduled();
    input.payloads = [encodeSetter(paramSpec("voteWindow"), 7200n), input.payloads[1]!];
    expect(refuse(input)).toBe("operation_mismatch");
  });
});

describe("API", () => {
  it("is invisible to non-admins and refuses cross-origin writes", async () => {
    expect((await send(scheduleRoute, other, scheduled())).status).toBe(404);
    expect((await send(scheduleRoute, null, scheduled())).status).toBe(404);
    expect((await send(listRoute, other, null, { method: "GET" })).status).toBe(404);
    expect((await send(scheduleRoute, admin, scheduled(), { origin: "https://evil.example" })).status).toBe(403);
  });

  it("answers not_configured where the environment has no deployment (local)", async () => {
    expect(consoleContracts("local")).toBeNull();
    expect(await send(scheduleRoute, admin, scheduled())).toEqual({ status: 503, json: { error: "not_configured" } });
  });

  it("records a scheduled change once, audits it, and lists it", async () => {
    const input = scheduled();
    const { id } = await recordScheduled(getDb(), admin.id, input, contracts, "127.0.0.1");
    ids.push(id);

    await expect(recordScheduled(getDb(), admin.id, input, contracts)).rejects.toMatchObject({ code: "duplicate" });

    const [row] = await getDb().select().from(contractChanges).where(eq(contractChanges.id, id));
    expect(row).toMatchObject({
      operationId: input.operationId.toLowerCase(),
      timelock: contracts.timelock.toLowerCase(),
      delaySeconds: 300,
      scheduledBy: admin.id,
      executedAt: null,
      cancelledAt: null,
    });
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audits.map((a) => a.action)).toEqual(["contracts.change_scheduled"]);

    const list = await send(listRoute, admin, null, { method: "GET" });
    expect(list.status).toBe(200);
    const listed = (list.json!.changes as { id: string; lines: unknown }[]).find((c) => c.id === id);
    expect(listed?.lines).toEqual([
      { key: "voteWindow", from: "86400", to: "3600" },
      { key: "quorumBps", from: "5000", to: "2500" },
    ]);
  });

  it("refuses a forged operation before writing anything", async () => {
    const forged = scheduled({ operationId: salt() }); // random, so a leftover row can never match
    await expect(recordScheduled(getDb(), admin.id, forged, contracts)).rejects.toMatchObject({ code: "operation_mismatch" });
    const rows = await getDb().select().from(contractChanges).where(eq(contractChanges.operationId, forged.operationId));
    expect(rows).toEqual([]);
  });

  it("closes a change once: executed or cancelled, never both", async () => {
    const { id: a } = await recordScheduled(getDb(), admin.id, scheduled(), contracts);
    const { id: b } = await recordScheduled(getDb(), admin.id, scheduled(), contracts);
    ids.push(a, b);

    const executed = await send(executedRoute, admin, { txHash: txHash() }, { id: a });
    expect(executed.status).toBe(200);
    expect((await send(cancelledRoute, admin, { txHash: txHash() }, { id: a })).json).toEqual({ error: "already_closed" });

    expect((await send(cancelledRoute, admin, { txHash: txHash() }, { id: b })).status).toBe(200);
    expect((await send(executedRoute, admin, { txHash: txHash() }, { id: b })).json).toEqual({ error: "already_closed" });

    const [rowA] = await getDb().select().from(contractChanges).where(eq(contractChanges.id, a));
    const [rowB] = await getDb().select().from(contractChanges).where(eq(contractChanges.id, b));
    expect(rowA!.executedBy).toBe(admin.id);
    expect(rowA!.cancelledAt).toBeNull();
    expect(rowB!.cancelledBy).toBe(admin.id);
    expect(rowB!.executedAt).toBeNull();
    const actions = (await getDb().select().from(auditLog).where(inArray(auditLog.entityId, [a, b]))).map((x) => x.action).sort();
    expect(actions).toEqual([
      "contracts.change_cancelled", "contracts.change_executed", "contracts.change_scheduled", "contracts.change_scheduled",
    ]);

    expect((await send(executedRoute, admin, { txHash: txHash() }, { id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await send(executedRoute, other, { txHash: txHash() }, { id: a })).status).toBe(404);
  });
});
