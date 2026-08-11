#!/usr/bin/env bash
# Generates renewal-scout-source.txt — a complete plain-text export of all
# source files needed to understand, audit, or reproduce the project.
#
# Excludes: node_modules, .git, build output (dist/), .env*, coverage, the
# export file itself, the ZIP, secrets, lock files above pnpm-lock.yaml.
#
# Usage: bash scripts/generate-export.sh [output-path]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$ROOT/renewal-scout-export.txt}"

echo "# RENEWAL SCOUT — FULL SOURCE EXPORT" > "$OUTPUT"
echo "# Generated: $(date -u)" >> "$OUTPUT"
echo "" >> "$OUTPUT"

append_file() {
  local path="$1"
  local rel="${path#$ROOT/}"
  echo "" >> "$OUTPUT"
  echo "════════════════════════════════════════" >> "$OUTPUT"
  echo "FILE: $rel" >> "$OUTPUT"
  echo "════════════════════════════════════════" >> "$OUTPUT"
  cat "$path" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
}

# ─── Helper: append all files matching a glob pattern ────────────────────────
append_glob() {
  local pattern="$1"
  # Use find to expand glob safely
  while IFS= read -r -d '' file; do
    append_file "$file"
  done < <(find $ROOT/$pattern -maxdepth 0 -type f -print0 2>/dev/null || true)
}

append_dir() {
  local dir="$ROOT/$1"
  local exts="${2:-ts,tsx,js,mjs,json,sql,yaml,toml,md}"
  if [ ! -d "$dir" ]; then return; fi
  while IFS= read -r -d '' file; do
    # Skip node_modules, dist, .git, coverage
    case "$file" in
      */node_modules/*|*/.git/*|*/dist/*|*/coverage/*|*/.turbo/*) continue ;;
    esac
    append_file "$file"
  done < <(find "$dir" -type f \( \
    -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.mjs" \
    -o -name "*.json" -o -name "*.sql" -o -name "*.yaml" -o -name "*.toml" \
    -o -name "*.md" -o -name "*.sh" -o -name "*.css" -o -name "*.html" \
  \) -not -path "*/node_modules/*" -not -path "*/.git/*" \
     -not -path "*/dist/*" -not -path "*/coverage/*" \
     -not -path "*/.turbo/*" -print0 2>/dev/null | sort -z)
}

# ─── Root config files ────────────────────────────────────────────────────────
for f in \
  pnpm-workspace.yaml \
  package.json \
  tsconfig.json \
  pnpm-lock.yaml \
  .replit \
  artifact.toml \
; do
  [ -f "$ROOT/$f" ] && append_file "$ROOT/$f"
done

# ─── Database library ─────────────────────────────────────────────────────────
append_dir lib/db

# ─── API Zod validation library ───────────────────────────────────────────────
append_dir lib/api-zod

# ─── API client (generated React hooks) ───────────────────────────────────────
append_dir lib/api-client-react

# ─── API server ───────────────────────────────────────────────────────────────
append_dir artifacts/api-server

# ─── Frontend (renewal-scout) ─────────────────────────────────────────────────
append_dir artifacts/renewal-scout

# ─── Scripts ──────────────────────────────────────────────────────────────────
append_dir scripts

echo ""
echo "════════════════════════════════════════" >> "$OUTPUT"
echo "END OF EXPORT" >> "$OUTPUT"
echo "════════════════════════════════════════" >> "$OUTPUT"

echo "✓ Export written to: $OUTPUT"
echo "  Size: $(wc -l < "$OUTPUT") lines, $(wc -c < "$OUTPUT") bytes"
