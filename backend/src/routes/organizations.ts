/**
 * Organization CRUD + membership + workspace attach.
 */

import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";
import { logger } from "../logger.js";
import {
  addMember,
  assertOrgMember,
  assertOrgRole,
  attachWorkspaceToOrg,
  backfillPersonalOrganizations,
  createOrganization,
  deleteOrganization,
  getOrganization,
  listMembers,
  listOrganizationsForUser,
  removeMember,
  setMemberRole,
  updateOrganization,
  type OrgRole,
} from "../services/organizationService.js";
import { pool } from "../db/index.js";

export const organizationsRouter = Router();

function statusOf(e: unknown) {
  return (e as { status?: number }).status;
}

function handle(e: unknown, res: import("express").Response, fallback: string) {
  const status = statusOf(e);
  if (status) return res.status(status).json({ error: (e as Error).message });
  logger.error({ err: e }, fallback);
  return res.status(500).json({ error: fallback });
}

const createSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(100).optional(),
});

const memberSchema = z.object({
  user_id: z.string().uuid(),
  org_role: z.enum(["owner", "admin", "member"]).default("member"),
});

const roleSchema = z.object({
  org_role: z.enum(["owner", "admin", "member"]),
});

const attachSchema = z.object({
  workspace_id: z.string().uuid(),
  organization_id: z.string().uuid().nullable(),
});
const tradingWindowSchema = z
  .object({
    status: z.enum(["open", "closed"]),
    from: z.string().date().nullable().optional(),
    until: z.string().date().nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.until && value.from > value.until) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["until"],
        message: "Trading-window end date must be on or after its start date",
      });
    }
  });

/** List orgs I belong to */
organizationsRouter.get("/", async (req, res) => {
  try {
    const organizations = await listOrganizationsForUser(req.user!.userId);
    return res.json({ organizations });
  } catch (e) {
    return handle(e, res, "Failed to list organizations");
  }
});

/** Admin: create org */
organizationsRouter.post(
  "/",
  requireRole("admin"),
  validateBody(createSchema),
  async (req, res) => {
    try {
      const org = await createOrganization(req.body.name, req.user!.userId, req.body.slug);
      return res.status(201).json(org);
    } catch (e) {
      return handle(e, res, "Failed to create organization");
    }
  },
);

/** Admin: backfill personal orgs for workspace owners */
organizationsRouter.post("/backfill", requireRole("admin"), async (_req, res) => {
  try {
    const result = await backfillPersonalOrganizations();
    return res.json(result);
  } catch (e) {
    return handle(e, res, "Backfill failed");
  }
});

/** Attach / detach workspace ↔ organization (before /:id) */
organizationsRouter.patch("/workspaces/attach", validateBody(attachSchema), async (req, res) => {
  try {
    const result = await attachWorkspaceToOrg(
      req.body.workspace_id,
      req.body.organization_id,
      req.user!.userId,
      { allowAdmin: req.user!.role === "admin" },
    );
    return res.json(result);
  } catch (e) {
    return handle(e, res, "Failed to attach workspace");
  }
});

organizationsRouter.get("/:id", async (req, res) => {
  try {
    await assertOrgMember(req.user!.userId, req.params.id);
    const org = await getOrganization(req.params.id);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    return res.json(org);
  } catch (e) {
    return handle(e, res, "Failed to get organization");
  }
});

organizationsRouter.patch(
  "/:id/trading-window",
  validateBody(tradingWindowSchema),
  async (req, res) => {
    try {
      await assertOrgRole(req.user!.userId, req.params.id, ["owner", "admin"]);
      const result = await pool.query(
        `UPDATE organizations
         SET trading_window_status = $2, trading_window_from = $3,
             trading_window_until = $4, trading_window_note = $5, updated_at = NOW()
         WHERE organization_id = $1
         RETURNING organization_id, trading_window_status, trading_window_from,
                   trading_window_until, trading_window_note`,
        [
          req.params.id,
          req.body.status,
          req.body.from ?? null,
          req.body.until ?? null,
          req.body.note ?? null,
        ],
      );
      if (!result.rows[0]) return res.status(404).json({ error: "Organization not found" });
      return res.json(result.rows[0]);
    } catch (e) {
      return handle(e, res, "Failed to update trading window");
    }
  },
);

organizationsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  async (req, res) => {
    try {
      await assertOrgRole(req.user!.userId, req.params.id, ["owner", "admin"]);
      const org = await updateOrganization(req.params.id, req.body);
      return res.json(org);
    } catch (e) {
      return handle(e, res, "Failed to update organization");
    }
  },
);

organizationsRouter.delete("/:id", async (req, res) => {
  try {
    await assertOrgRole(req.user!.userId, req.params.id, ["owner"]);
    await deleteOrganization(req.params.id);
    return res.json({ deleted: true, organization_id: req.params.id });
  } catch (e) {
    return handle(e, res, "Failed to delete organization");
  }
});

organizationsRouter.get("/:id/members", async (req, res) => {
  try {
    await assertOrgMember(req.user!.userId, req.params.id);
    const members = await listMembers(req.params.id);
    return res.json({ members });
  } catch (e) {
    return handle(e, res, "Failed to list members");
  }
});

organizationsRouter.post(
  "/:id/members",
  validateBody(memberSchema),
  async (req, res) => {
    try {
      await assertOrgRole(req.user!.userId, req.params.id, ["owner", "admin"]);
      const member = await addMember(
        req.params.id,
        req.body.user_id,
        req.body.org_role as OrgRole,
      );
      return res.status(201).json(member);
    } catch (e) {
      return handle(e, res, "Failed to add member");
    }
  },
);

organizationsRouter.patch(
  "/:id/members/:userId",
  validateBody(roleSchema),
  async (req, res) => {
    try {
      await assertOrgRole(req.user!.userId, req.params.id, ["owner", "admin"]);
      const member = await setMemberRole(
        req.params.id,
        req.params.userId,
        req.body.org_role as OrgRole,
      );
      return res.json(member);
    } catch (e) {
      return handle(e, res, "Failed to set member role");
    }
  },
);

organizationsRouter.delete("/:id/members/:userId", async (req, res) => {
  try {
    await assertOrgRole(req.user!.userId, req.params.id, ["owner", "admin"]);
    await removeMember(req.params.id, req.params.userId);
    return res.json({ removed: true, user_id: req.params.userId });
  } catch (e) {
    return handle(e, res, "Failed to remove member");
  }
});
