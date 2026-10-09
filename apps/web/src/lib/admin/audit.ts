import { and, desc, eq, ilike, isNull } from "drizzle-orm";
import { auditLog, users, type Database } from "@cherrio/db";
import { containsPattern, PAGE_SIZE, type Cursor, type SearchParams } from "./listing";
import { afterCursor, sortKey } from "./organizations";

// Admin → Audit log (TASK-021): a read-only view of app.audit_log, newest first,
// keyset pages. The IP column is not shown (GDPR minimisation — it is kept for
// abuse investigations on the server, and erased with the account).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditFilters {
  /** Part of the action name, e.g. "kyb." or "mfa". */
  q: string;
  /** Exact entity type ("campaign", "organization", …) or "" for all. */
  type: string;
  /** A user id, "system" (no actor) or "" for everyone. */
  actor: string;
  /** Exact entity id or "". */
  entity: string;
}

const one = (value: string | string[] | undefined) => ((Array.isArray(value) ? value[0] : value) ?? "").trim();

/** Filters from the URL; malformed values are dropped (the list then shows everything for that filter). */
export function auditFilters(params: SearchParams, types: readonly string[]): AuditFilters {
  const actor = one(params.actor);
  const entity = one(params.entity);
  const type = one(params.type);
  return {
    q: one(params.q).slice(0, 100),
    type: types.includes(type) ? type : "",
    actor: actor === "system" || UUID.test(actor) ? actor.toLowerCase() : "",
    entity: UUID.test(entity) ? entity.toLowerCase() : "",
  };
}

/** Entity types that occur in the log, for the filter (uses the (entity_type, entity_id) index). */
export async function auditEntityTypes(db: Database): Promise<string[]> {
  const rows = await db.selectDistinct({ type: auditLog.entityType }).from(auditLog).orderBy(auditLog.entityType);
  return rows.map((r) => r.type);
}

export interface AuditRow {
  id: string;
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  data: unknown;
  key: string;
}

/** One page of the audit log, newest first; `next` is the cursor of the following page (or null). */
export async function listAuditLog(db: Database, filters: AuditFilters, cursor: Cursor | null) {
  const rows: AuditRow[] = await db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      actorUserId: auditLog.actorUserId,
      actorName: users.displayName,
      data: auditLog.data,
      key: sortKey(auditLog.createdAt),
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      and(
        filters.q ? ilike(auditLog.action, containsPattern(filters.q)) : undefined,
        filters.type ? eq(auditLog.entityType, filters.type) : undefined,
        filters.actor === "system"
          ? isNull(auditLog.actorUserId)
          : filters.actor
            ? eq(auditLog.actorUserId, filters.actor)
            : undefined,
        filters.entity ? eq(auditLog.entityId, filters.entity) : undefined,
        afterCursor(auditLog.createdAt, auditLog.id, "desc", cursor)
      )
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > PAGE_SIZE && last ? { key: last.key, id: last.id } : null };
}

/** Admin page of an entity, when there is one. */
export function auditEntityHref(type: string, id: string | null): string | null {
  if (!id) return null;
  switch (type) {
    case "campaign":
      return `/admin/campaigns/${id}`;
    case "organization":
      return `/admin/organizations/${id}`;
    case "kyb_submission":
      return `/admin/kyb/${id}`;
    default:
      return null;
  }
}

/** The data column as one line of compact JSON (null when empty). */
export function auditDataText(data: unknown): string | null {
  if (data === null || data === undefined) return null;
  if (typeof data === "object" && Object.keys(data as object).length === 0) return null;
  return JSON.stringify(data);
}
