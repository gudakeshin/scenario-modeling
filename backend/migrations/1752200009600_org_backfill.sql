-- Backfill personal organizations for workspace owners lacking organization_id.
-- Safe to re-run: only touches workspaces WHERE organization_id IS NULL.

DO $$
DECLARE
  owner RECORD;
  org_id UUID;
  org_name TEXT;
  org_slug TEXT;
  base_slug TEXT;
  suffix INT;
BEGIN
  FOR owner IN
    SELECT DISTINCT w.owner_id, u.email, COALESCE(NULLIF(TRIM(u.name), ''), split_part(u.email, '@', 1), 'user') AS label
    FROM workspaces w
    JOIN users u ON u.user_id = w.owner_id
    WHERE w.status = 'active' AND w.organization_id IS NULL
  LOOP
    SELECT o.organization_id INTO org_id
    FROM organizations o
    JOIN organization_members m ON m.organization_id = o.organization_id
    WHERE m.user_id = owner.owner_id AND m.org_role = 'owner'
    ORDER BY o.created_at ASC
    LIMIT 1;

    IF org_id IS NULL THEN
      org_name := owner.label || '''s Organization';
      base_slug := lower(regexp_replace(owner.label, '[^a-zA-Z0-9]+', '-', 'g'));
      base_slug := trim(both '-' from base_slug);
      IF base_slug = '' THEN base_slug := 'org'; END IF;
      base_slug := left(base_slug, 60);
      org_slug := base_slug;
      suffix := 0;
      WHILE EXISTS (SELECT 1 FROM organizations WHERE slug = org_slug) LOOP
        suffix := suffix + 1;
        org_slug := base_slug || '-' || suffix::text;
      END LOOP;

      INSERT INTO organizations (name, slug)
      VALUES (org_name, org_slug)
      RETURNING organization_id INTO org_id;

      INSERT INTO organization_members (organization_id, user_id, org_role)
      VALUES (org_id, owner.owner_id, 'owner')
      ON CONFLICT (organization_id, user_id) DO NOTHING;
    END IF;

    UPDATE workspaces
    SET organization_id = org_id, updated_at = NOW()
    WHERE owner_id = owner.owner_id
      AND status = 'active'
      AND organization_id IS NULL;
  END LOOP;
END $$;
