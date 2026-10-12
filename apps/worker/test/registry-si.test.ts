import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { computeTrustScores, TRUST_SCORE_VERSION } from "../src/trust.js";
import { ensureFakeChain } from "../../web/src/__tests__/helpers/fake-chain.js";
import {
  classifySi,
  downloadEno,
  enoOrganisations,
  fieldCauses,
  importSiFromXml,
  lastSiImport,
  SI_ACCEPTED_FIELDS,
  SI_PARSER_VERSION,
  titleCaseSl,
} from "../src/registry/si.js";

// TASK-016c: Slovenian ENO import (ADR-062), against Postgres, with a small
// extract in the real AJPES format: a fire brigade, a radio club in the disaster
// field, a humanitarian body, a sports club, a mixed sport/disability union, a
// deleted organisation, one whose only status was withdrawn, one with a
// withdrawn sport status next to valid ones, and a record without a number.

const url = process.env.DATABASE_URL;
if (!url) throw new Error("registry tests need DATABASE_URL");
const db = schema.createDb(url, { max: 2 });
const { organizations, registryRecords } = schema;
const XML = readFileSync(join(__dirname, "fixtures/eno/ENO_sample.xml"), "utf8");
const TODAY = "2026-10-12";
const id = (n: number) => `990000000${n}`;
const IDS = [1, 2, 3, 4, 5, 6, 7, 8].map(id);

async function clean() {
  await db.delete(organizations).where(and(eq(organizations.registry, "SI_AJPES"), like(organizations.registryId, "99000000%")));
  await db.delete(registryRecords).where(and(eq(registryRecords.registry, "SI_AJPES"), like(registryRecords.registryId, "99000000%")));
}
const record = async (n: number) =>
  (await db.select().from(registryRecords).where(and(eq(registryRecords.registry, "SI_AJPES"), eq(registryRecords.registryId, id(n)))))[0];
const org = async (n: number) =>
  (await db.select().from(organizations).where(and(eq(organizations.registry, "SI_AJPES"), eq(organizations.registryId, id(n)))))[0];
const listed = async (n: number) => {
  const o = (await org(n))!;
  const [t] = await db.select().from(schema.trustScores).where(and(eq(schema.trustScores.orgId, o.id), eq(schema.trustScores.version, TRUST_SCORE_VERSION)));
  return t?.listed;
};
const only = (xml: string, keep: number[]) =>
  xml.replace(/ {2}<NevladnaOrganizacija>[\s\S]*?<\/NevladnaOrganizacija>\n/g, (block) => {
    const m = /<Maticna>(\d+)<\/Maticna>/.exec(block);
    return m && keep.includes(Number(m[1]!.slice(-1))) ? block : "";
  });

const STARTED = new Date();
beforeAll(async () => {
  await ensureFakeChain(db);
  await clean();
});
afterAll(async () => {
  const ours = db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.registry, "SI_AJPES"), like(organizations.registryId, "99000000%")));
  await db.delete(schema.trustScores).where(inArray(schema.trustScores.orgId, ours));
  await clean();
  await db.delete(schema.auditLog).where(and(eq(schema.auditLog.action, "registry.imported"), gte(schema.auditLog.createdAt, STARTED)));
  await db.$client.end();
});

describe("ENO extract parsing and rules", () => {
  it("reads every organisation with a number, decodes entities, keeps withdrawals and deletions", () => {
    const orgs = [...enoOrganisations(XML)];
    expect(orgs.map((o) => o.registrationNumber)).toEqual(IDS);
    expect(orgs[2]!.name).toBe("DRUŠTVO ZA POMOČ OSEBAM Z MOTNJAMI & NJIHOVIM DRUŽINAM ČRNOMELJ");
    expect(orgs[2]!.legalForm).toBe("Zavod");
    expect(orgs[5]!.deletedOn).toBe("2026-09-08");
    expect(orgs[6]!.statuses).toEqual([{ field: "Socialno varstvo", grantedOn: "2019-03-01", withdrawnOn: "2020-01-15" }]);
    expect(orgs[7]!.statuses[2]!.field).toBe("Izobraževanje - vzgoja in izobraževanje"); // double space in the register
  });

  it("decides by the state-granted field only", () => {
    const decisions = [...enoOrganisations(XML)].map((o) => {
      const c = classifySi(o, TODAY);
      return [o.registrationNumber.slice(-1), c.decision, c.reason, c.causes.join(",")];
    });
    expect(decisions).toEqual([
      ["1", "ACCEPT", null, "disasters"],
      ["2", "REVIEW", "disaster-field-not-rescue", "disasters"],
      ["3", "ACCEPT", null, "medical"],
      ["4", "EXCLUDE", null, ""],
      ["5", "REVIEW", "also-excluded-field", "medical"],
      ["6", "REMOVED", "deleted-from-eno", ""],
      ["7", "REMOVED", "status-withdrawn", ""],
      ["8", "ACCEPT", null, "education,poverty"], // the withdrawn sport status does not count
    ]);
  });

  it("a withdrawal or deletion in the future does not count yet", () => {
    const [, , , , , deleted, withdrawn] = [...enoOrganisations(XML)];
    expect(classifySi(deleted!, "2026-09-07").decision).toBe("ACCEPT");
    expect(classifySi(withdrawn!, "2020-01-14").decision).toBe("ACCEPT");
  });

  it("maps fields to causes; sport, culture, defence and veterans are never accepted", () => {
    expect(fieldCauses("Humanitarna dejavnost - socialno varstvo")).toEqual(["poverty"]);
    expect(fieldCauses("Humanitarna dejavnost - za opravljanje humanitarne dejavnosti na področju socialnega varstva")).toEqual(["poverty"]);
    expect(fieldCauses("Humanitarna dejavnost - zdravstveno varstvo")).toEqual(["medical"]);
    expect(fieldCauses("Humanitarna dejavnost - drugo")).toEqual(["poverty"]);
    for (const f of ["Šport", "Kultura - drugo", "Obramba", "Vojni veterani", "Kmetijstvo, gozdarstvo in prehrana - drugo", "Izobraževanje - visoko šolstvo", "Spodbujanje razvoja turizma"]) {
      expect(fieldCauses(f), f).toBeNull();
    }
    for (const [f, causes] of Object.entries(SI_ACCEPTED_FIELDS)) expect(causes.length, f).toBeGreaterThan(0);
  });

  it("title-cases capital names (like the UK import), with Slovenian letters, and keeps mixed-case names", () => {
    expect(titleCaseSl("DRUŠTVO ZA POMOČ OSEBAM Z MOTNJAMI V DUŠEVNEM RAZVOJU ŠKOFJA LOKA")).toBe(
      "Društvo za Pomoč Osebam z Motnjami v Duševnem Razvoju Škofja Loka",
    );
    expect(titleCaseSl("PGD ČRNOMELJ")).toBe("PGD Črnomelj");
    expect(titleCaseSl("Zveza za šport invalidov Slovenije")).toBe("Zveza za šport invalidov Slovenije");
  });
});

describe("ENO import (Postgres)", () => {
  it("imports accepted organisations, keeps the rest as records with their decision, no street address", async () => {
    const r = await importSiFromXml(db, XML, "2026-09", { today: TODAY, minOrganisations: 1 });
    expect(r.decisions).toEqual({ ACCEPT: 3, REVIEW: 2, EXCLUDE: 1, REMOVED: 2 });
    expect(r.records).toBe(8);
    expect(r.organizations).toEqual({ inserted: 3, updated: 0 });
    expect(r.missing).toBe(0);

    const imported = await db.select().from(organizations).where(and(eq(organizations.registry, "SI_AJPES"), inArray(organizations.registryId, IDS)));
    expect(imported.map((o) => o.registryId).sort()).toEqual([id(1), id(3), id(8)]);
    const humanitarian = (await org(3))!;
    expect(humanitarian).toMatchObject({ source: "IMPORTED", country: "SI", kybStatus: "NONE", causes: ["medical"] });
    expect(humanitarian.name).toBe("Društvo za Pomoč Osebam z Motnjami & Njihovim Družinam Črnomelj");

    expect((await record(2))!.raw).toMatchObject({ status: "Review", reason: "disaster-field-not-rescue" });
    expect((await record(4))!.raw).toMatchObject({ status: "Excluded", publicInterestFields: "Šport" });
    expect((await record(6))!.raw).toMatchObject({ status: "Removed", removedOn: "2026-09-08" });
    const accepted = (await record(8))!.raw as Record<string, unknown>;
    expect(accepted).toMatchObject({
      status: "Registered",
      publicInterestFields: "Izobraževanje - vzgoja in izobraževanje | Socialno varstvo",
      publicInterestSince: "2018-05-02",
      municipality: "Ljubljana",
      extract: "2026-09",
    });
    expect(JSON.stringify(accepted)).not.toContain("Testna ulica");
    expect(await lastSiImport(db)).not.toBeNull();
  });

  it("a second run changes nothing; a claimed organisation is never changed", async () => {
    await db.update(organizations).set({ source: "REGISTERED", name: "Our own name" }).where(and(eq(organizations.registry, "SI_AJPES"), eq(organizations.registryId, id(3))));
    const r = await importSiFromXml(db, XML, "2026-09", { today: TODAY, minOrganisations: 1 });
    expect(r.organizations).toEqual({ inserted: 0, updated: 0 });
    expect((await org(3))!.name).toBe("Our own name");
  });

  it("an organisation missing from the next extract is marked removed (off the Market Cap)", async () => {
    const r = await importSiFromXml(db, only(XML, [2, 3, 4, 5, 6, 7, 8]), "2026-10", { today: TODAY, minOrganisations: 1 });
    expect(r.missing).toBe(1);
    expect((await record(1))!.raw).toMatchObject({ status: "Removed", reason: "not-in-extract", extract: "2026-10" });
    expect((await org(1))!.name).toBe("Prostovoljno Gasilsko Društvo Testna Vas"); // the row stays; the trust score stops listing it
    await computeTrustScores(db, "imported");
    expect(await listed(1)).toBe(false);
    expect(await listed(8)).toBe(true);
    // Back in a later extract: listed again.
    await importSiFromXml(db, XML, "2026-11", { today: TODAY, minOrganisations: 1 });
    expect((await record(1))!.raw).toMatchObject({ status: "Registered", extract: "2026-11" });
    await computeTrustScores(db, "imported");
    expect(await listed(1)).toBe(true);
  });

  it("a short (broken) extract imports and removes nothing", async () => {
    await expect(importSiFromXml(db, only(XML, [1]), "2026-12", { today: TODAY, minOrganisations: 2 })).rejects.toThrow(/has 1 organisations/);
    expect((await record(3))!.raw).toMatchObject({ extract: "2026-11" });
  });

  it("parser version is recorded with the run", () => {
    expect(SI_PARSER_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("ENO download", () => {
  let server: Server;
  let base = "";
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === "/ENO_2026_08.xml") res.end(XML);
      else if (req.url === "/ENO_2026_07.xml") res.end("<html>not it</html>");
      else res.writeHead(404).end("missing");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const at = (y: number, m: number) => `${base}/ENO_${y}_${String(m).padStart(2, "0")}.xml`;

  it("takes last month's extract, or the month before when it is not published yet", async () => {
    const got = await downloadEno(new Date("2026-10-03T10:00:00Z"), at);
    expect(got.extract).toBe("2026-08");
    expect(hits).toEqual(["/ENO_2026_09.xml", "/ENO_2026_08.xml"]);
    expect(got.xml).toContain("<NevladneOrganizacije>");
  });

  it("refuses a file that is not an extract, and fails when neither month exists", async () => {
    await expect(downloadEno(new Date("2026-08-15T10:00:00Z"), at)).rejects.toThrow(/not an ENO extract/);
    await expect(downloadEno(new Date("2026-03-15T10:00:00Z"), at)).rejects.toThrow(/ENO download failed: 404/);
  });
});
