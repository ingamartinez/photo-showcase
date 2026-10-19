-- Task #257 (epic #250) — acceptance queries for the backfill, run against a
-- RESTORED PRODUCTION BACKUP after applying 0017 (plan §9.4). Nothing here
-- runs against the live database.
--
--   psql -h /tmp -d <scratch_b> -v ON_ERROR_STOP=1 -f scripts/asset-picks-backfill-verify.sql
--
-- Every SELECT is a named check whose expected values and failure meaning are
-- tabulated in plan §9.4. `s2_baseline.*` comes from
-- scripts/asset-picks-backfill-baseline.sql, taken before the migration.
\set ON_ERROR_STOP 1
\pset pager off

-- V0: baseline vs census (S1, #256).
SELECT 'V0 baseline' AS check,
  count(*) FILTER (WHERE is_selected) AS selected,
  count(*) FILTER (WHERE is_selected AND selected_by IS NULL) AS selected_by_null,
  count(*) FILTER (WHERE is_selected AND requested_at IS NULL) AS requested_null,
  count(DISTINCT gallery_id) FILTER (WHERE is_selected) AS galleries
FROM s2_baseline.assets;

-- (i) exactly one pick per baseline pick, same person, same kind; no extra picks.
WITH expected AS (
  SELECT id AS asset_id, gallery_id, selected_by AS user_id, selection_kind AS kind
  FROM s2_baseline.assets WHERE is_selected AND selected_by IS NOT NULL
)
SELECT '(i) one pick per selected asset' AS check,
  (SELECT count(*) FROM expected) AS expected_picks,
  (SELECT count(*) FROM asset_picks) AS actual_picks,
  (SELECT count(*) FROM expected e LEFT JOIN asset_picks p
     ON p.asset_id = e.asset_id AND p.user_id = e.user_id AND p.gallery_id = e.gallery_id AND p.kind = e.kind
   WHERE p.asset_id IS NULL) AS missing_or_wrong,
  (SELECT count(*) FROM asset_picks p LEFT JOIN expected e
     ON e.asset_id = p.asset_id AND e.user_id = p.user_id
   WHERE e.asset_id IS NULL) AS unexpected,
  (SELECT count(*) FROM (SELECT asset_id FROM asset_picks GROUP BY asset_id HAVING count(*) > 1) d) AS assets_with_2plus;

-- (ii) picks per gallery = baseline per gallery (rows only on mismatch).
SELECT '(ii) per-gallery mismatch' AS check, coalesce(b.gallery_id, p.gallery_id) AS gallery_id, b.n AS before, p.n AS picks
FROM (SELECT gallery_id, count(*) n FROM s2_baseline.assets WHERE is_selected AND selected_by IS NOT NULL GROUP BY 1) b
FULL JOIN (SELECT gallery_id, count(*) n FROM asset_picks GROUP BY 1) p USING (gallery_id)
WHERE b.n IS DISTINCT FROM p.n;

-- (iii) claimed = before - carts; carts only outside closed galleries; per gallery.
SELECT '(iii) per gallery' AS check, g.title, g.status, g.rolling_delivery,
  b.before_selected, coalesce(c.carts, 0) AS carts, coalesce(n.claimed, 0) AS claimed_now,
  b.before_selected - coalesce(c.carts, 0) = coalesce(n.claimed, 0) AS ok
FROM (SELECT gallery_id, count(*) before_selected FROM s2_baseline.assets WHERE is_selected GROUP BY 1) b
JOIN galleries g ON g.id = b.gallery_id
LEFT JOIN (SELECT gallery_id, count(*) carts FROM asset_picks WHERE submitted_at IS NULL GROUP BY 1) c USING (gallery_id)
LEFT JOIN (SELECT gallery_id, count(*) claimed FROM assets WHERE is_selected GROUP BY 1) n USING (gallery_id)
WHERE coalesce(c.carts, 0) > 0 OR b.before_selected - coalesce(c.carts, 0) <> coalesce(n.claimed, 0)
ORDER BY g.title;

SELECT '(iii) totals' AS check,
  (SELECT count(*) FROM asset_picks WHERE submitted_at IS NOT NULL) AS submitted_picks,
  (SELECT count(*) FROM asset_picks WHERE submitted_at IS NULL) AS cart_picks,
  (SELECT count(*) FROM assets WHERE is_selected) AS claimed,
  (SELECT count(*) FROM assets WHERE is_selected AND selected_by IS NULL) AS claimed_unattributed,
  (SELECT count(*) FROM asset_picks p JOIN galleries g ON g.id = p.gallery_id
     WHERE p.submitted_at IS NULL AND g.status IN ('selected','delivered','archived')) AS carts_in_closed,
  (SELECT count(*) FROM assets a WHERE a.is_selected AND a.selected_by IS NULL
     AND EXISTS (SELECT 1 FROM asset_picks p WHERE p.asset_id = a.id)) AS unattributed_with_pick;

-- (iii-b) the cart rule agrees with the census rule (gc.selection_submitted_at IS NULL).
SELECT '(iii-b) rule drift' AS check, count(*) AS rows_where_rules_disagree
FROM asset_picks p
JOIN s2_baseline.galleries g ON g.id = p.gallery_id
JOIN s2_baseline.gallery_clients gc ON gc.gallery_id = p.gallery_id AND gc.user_id = p.user_id
WHERE g.status NOT IN ('selected','delivered','archived')
  AND (p.submitted_at IS NULL) <> (gc.selection_submitted_at IS NULL);

-- (iii-c) cart assets fully released; claimed assets keep their old values.
SELECT '(iii-c) asset columns' AS check,
  count(*) FILTER (WHERE p.submitted_at IS NULL AND (a.is_selected OR a.selected_by IS NOT NULL OR a.selected_at IS NOT NULL
                   OR a.requested_at IS NOT NULL OR a.billed_at IS NOT NULL OR a.selection_kind <> 'edited')) AS dirty_carts,
  count(*) FILTER (WHERE p.submitted_at IS NOT NULL AND (a.is_selected, a.selected_by, a.selected_at, a.requested_at, a.selection_kind)
                   IS DISTINCT FROM (b.is_selected, b.selected_by, b.selected_at, b.requested_at, b.selection_kind)) AS changed_claims,
  count(*) FILTER (WHERE p.submitted_at IS NOT NULL AND a.billed_at IS DISTINCT FROM coalesce(b.requested_at, b.selected_at)) AS wrong_billed_at
FROM asset_picks p JOIN assets a ON a.id = p.asset_id JOIN s2_baseline.assets b ON b.id = a.id;

SELECT '(iii-d) assets outside picks untouched' AS check, count(*) AS changed
FROM assets a JOIN s2_baseline.assets b ON b.id = a.id
WHERE NOT EXISTS (SELECT 1 FROM asset_picks p WHERE p.asset_id = a.id)
  AND ((a.is_selected, a.selected_by, a.selected_at, a.requested_at, a.selection_kind, a.final_key, a.is_extra)
       IS DISTINCT FROM (b.is_selected, b.selected_by, b.selected_at, b.requested_at, b.selection_kind, b.final_key, b.is_extra)
       OR a.billed_at IS DISTINCT FROM CASE WHEN b.is_selected THEN coalesce(b.requested_at, b.selected_at) END);

-- (iv) closed galleries: status, gallery stamps, locks and quota inputs unchanged.
SELECT '(iv) galleries changed' AS check, count(*) AS n
FROM galleries g JOIN s2_baseline.galleries b ON b.id = g.id
WHERE (g.status, g.selection_submitted_at, g.rolling_delivery) IS DISTINCT FROM (b.status, b.selection_submitted_at, b.rolling_delivery);

SELECT '(iv) memberships changed' AS check,
  count(*) FILTER (WHERE g.status IN ('selected','delivered','archived')) AS in_closed,
  count(*) FILTER (WHERE g.status NOT IN ('selected','delivered','archived')) AS in_open_decision_20
FROM gallery_clients gc
JOIN s2_baseline.gallery_clients b USING (gallery_id, user_id)
JOIN galleries g ON g.id = gc.gallery_id
WHERE (gc.removed_at, gc.selection_locked_at, gc.selection_submitted_at, gc.selection_locked_by)
  IS DISTINCT FROM (b.removed_at, b.selection_locked_at, b.selection_submitted_at, b.selection_locked_by);

SELECT '(iv) decision 20 rows are exactly the classic client locks in proofing' AS check, count(*) AS bad
FROM gallery_clients gc
JOIN s2_baseline.gallery_clients b USING (gallery_id, user_id)
JOIN galleries g ON g.id = gc.gallery_id
WHERE (gc.selection_locked_at, gc.selection_locked_by) IS DISTINCT FROM (b.selection_locked_at, b.selection_locked_by)
  AND NOT (g.status = 'proofing' AND b.removed_at IS NULL AND b.selection_locked_by = 'client'
           AND gc.selection_locked_at IS NULL AND gc.selection_locked_by IS NULL
           AND gc.selection_submitted_at IS NOT DISTINCT FROM b.selection_submitted_at);

SELECT '(iv-b) closed quota inputs' AS check, count(*) AS galleries_with_changed_counts
FROM galleries g
JOIN (SELECT gallery_id, count(*) FILTER (WHERE is_selected AND selection_kind = 'edited') e,
             count(*) FILTER (WHERE is_selected AND selection_kind = 'original') o
      FROM s2_baseline.assets GROUP BY 1) b ON b.gallery_id = g.id
JOIN (SELECT gallery_id, count(*) FILTER (WHERE is_selected AND selection_kind = 'edited') e,
             count(*) FILTER (WHERE is_selected AND selection_kind = 'original') o
      FROM assets GROUP BY 1) n ON n.gallery_id = g.id
WHERE g.status IN ('selected','delivered','archived') AND (b.e, b.o) IS DISTINCT FROM (n.e, n.o);

-- Structure: the constraints the later slices rely on actually exist.
SELECT '(s) constraints' AS check, conname, contype, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE conrelid = 'asset_picks'::regclass ORDER BY conname;
SELECT '(s) indexes' AS check, indexname, indexdef FROM pg_indexes
WHERE indexname IN ('assets_id_gallery_id_idx', 'asset_picks_gallery_user_idx') ORDER BY 2;
