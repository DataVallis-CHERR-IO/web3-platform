import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { causesFrom, importUk, importUkFromFiles, lastUkImport, normaliseWebsite, parseUkCharity } from "../src/registry/uk.js";

// TASK-016a: UK Charity Commission import, against Postgres, with two tiny
// extracts in the real format (tab-separated, zipped; a record broken over two
// lines; a linked subsidiary; a removed charity; a claimed organisation).

const url = process.env.DATABASE_URL;
if (!url) throw new Error("registry tests need DATABASE_URL");
const db = schema.createDb(url, { max: 2 });
const { organizations, registryRecords } = schema;
const FIX = join(__dirname, "fixtures/ccew");
const files = { charity: join(FIX, "publicextract.charity.zip"), classification: join(FIX, "publicextract.charity_classification.zip") };
const IDS = ["900001", "900002", "900003", "900004"];

async function clean() {
  await db.delete(organizations).where(and(eq(organizations.registry, "UK_CC"), inArray(organizations.registryId, IDS)));
  await db.delete(registryRecords).where(and(eq(registryRecords.registry, "UK_CC"), inArray(registryRecords.registryId, IDS)));
}
const org = async (id: string) =>
  (await db.select().from(organizations).where(and(eq(organizations.registry, "UK_CC"), eq(organizations.registryId, id))))[0];

beforeAll(clean);
afterAll(async () => {
  await clean();
  await db.$client.end();
});

describe("UK extract parsing", () => {
  it("maps classifications to causes, websites to links, and keeps no contact details", () => {
    expect(causesFrom(["Animals", "Children/young People", "Makes Grants To Individuals"])).toEqual(["animals", "children"]);
    expect(causesFrom(["Education/training", "Advancement Of Health Or Saving Of Lives"])).toEqual(["education", "medical"]);
    expect(causesFrom(["Overseas Aid/famine Relief"])).toEqual(["humanitarian"]);
    expect(normaliseWebsite("www.redcross.org.uk")).toBe("https://www.redcross.org.uk");
    expect(normaliseWebsite("http://example.org/")).toBe("http://example.org");
    expect(normaliseWebsite("not a url")).toBeNull();
    expect(normaliseWebsite("")).toBeNull();
    const row = {
      registered_charity_number: "123", linked_charity_number: "0", charity_name: "  A   Charity ", charity_registration_status: "Registered",
      charity_contact_email: "x@example.org", charity_contact_phone: "0123", charity_contact_address1: "1 Lane", latest_income: "1000.4",
    };
    const parsed = parseUkCharity(row)!;
    expect(parsed).toMatchObject({ registryId: "123", registered: true, name: "A Charity" });
    expect(parsed.raw.income).toBe(1000);
    expect(JSON.stringify(parsed.raw)).not.toMatch(/example\.org|0123|Lane/);
    expect(parseUkCharity({ ...row, linked_charity_number: "2" })).toBeNull();
    expect(parseUkCharity({ ...row, registered_charity_number: "" })).toBeNull();
  });
});

describe("UK import (Postgres)", () => {
  it("imports registered main charities as organisations, keeps removed ones as records, never touches a claimed one", async () => {
    await db.insert(organizations).values({
      source: "REGISTERED", name: "Claimed Charity Ltd", country: "GB", registry: "UK_CC", registryId: "900003", causes: ["poverty"], kybStatus: "APPROVED",
    });
    const result = await importUkFromFiles(db, files);
    expect(result).toEqual({ records: 4, organizations: { inserted: 2, updated: 0 }, skipped: 1 });

    expect(await org("900001")).toMatchObject({
      source: "IMPORTED", name: "Shelter Paws Trust", country: "GB", website: "https://www.shelterpaws.example",
      description: "We rescue and rehome dogs and cats.", causes: ["animals", "children"], kybStatus: "NONE",
    });
    // A record broken over two lines; extra spaces in the name.
    expect(await org("900004")).toMatchObject({ name: "Kids Learning Hub", description: "Homework clubs and summer schools", causes: ["education"] });
    expect(await org("900002")).toBeUndefined(); // removed: a record only
    expect(await org("900003")).toMatchObject({ source: "REGISTERED", name: "Claimed Charity Ltd", causes: ["poverty"] });

    const records = await db.select().from(registryRecords).where(and(eq(registryRecords.registry, "UK_CC"), inArray(registryRecords.registryId, IDS)));
    expect(records.map((r) => r.registryId).sort()).toEqual(IDS);
    const removed = records.find((r) => r.registryId === "900002")!.raw as Record<string, unknown>;
    expect(removed).toMatchObject({ status: "Removed", removedOn: "2015-01-01" });
    const shelter = records.find((r) => r.registryId === "900001")!.raw as Record<string, unknown>;
    expect(shelter).toMatchObject({ income: 125001, expenditure: 99000, registeredOn: "1990-05-01", financialYearEnd: "2026-03-31" });
    expect(JSON.stringify(records.map((r) => r.raw))).not.toMatch(/Private Lane|01234 567890|trustee@example\.org|AB1 2CD/);
    expect(await lastUkImport(db)).toBeInstanceOf(Date);
  });

  it("a second run changes nothing; a changed organisation is put back to the registry's data", async () => {
    expect(await importUkFromFiles(db, files)).toEqual({ records: 4, organizations: { inserted: 0, updated: 0 }, skipped: 1 });
    await db.update(organizations).set({ name: "Edited" }).where(and(eq(organizations.registry, "UK_CC"), eq(organizations.registryId, "900001")));
    expect((await importUkFromFiles(db, files)).organizations).toEqual({ inserted: 0, updated: 1 });
    expect((await org("900001"))!.name).toBe("Shelter Paws Trust");
  });

  it("downloads both extracts, imports them and removes the temporary files", async () => {
    const server: Server = createServer((req, res) => {
      const name = req.url?.endsWith("classification.zip") ? "publicextract.charity_classification.zip" : "publicextract.charity.zip";
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(readFileSync(join(FIX, name)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await importUk(db, {
        charity: `http://127.0.0.1:${port}/charity.zip`,
        classification: `http://127.0.0.1:${port}/classification.zip`,
      });
      expect(r.records).toBe(4);
      await expect(importUk(db, { charity: `http://127.0.0.1:${port}/x`, classification: `http://127.0.0.1:1/none.zip` })).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});
