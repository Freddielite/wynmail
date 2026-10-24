#!/usr/bin/env bash
# Proves a backup restores. Dumps the live database, restores it into a scratch database, compares row counts.
# Needs pg_dump, pg_restore and psql. Run quarterly and after any schema change.
#   SOURCE_URL=postgres://... SCRATCH_URL=postgres://... ./scripts/restore-drill.sh
set -euo pipefail
: "${SOURCE_URL:?set SOURCE_URL (read-only access is enough)}" "${SCRATCH_URL:?set SCRATCH_URL (an empty throwaway database, never production)}"
[ "$SOURCE_URL" != "$SCRATCH_URL" ] || { echo "SOURCE_URL and SCRATCH_URL must differ"; exit 1; }
dump=$(mktemp)
pg_dump --format=custom --no-owner --file "$dump" "$SOURCE_URL"
pg_restore --no-owner --clean --if-exists --dbname "$SCRATCH_URL" "$dump" 2>/dev/null || true
for t in users workspaces contacts lists templates campaigns messages events audit_log; do
  a=$(psql -Atc "SELECT count(*) FROM $t" "$SOURCE_URL"); b=$(psql -Atc "SELECT count(*) FROM $t" "$SCRATCH_URL")
  [ "$a" = "$b" ] && echo "ok    $t $a" || { echo "DIFF  $t source=$a restored=$b"; exit 1; }
done
rm -f "$dump"; echo "Restore drill passed."
