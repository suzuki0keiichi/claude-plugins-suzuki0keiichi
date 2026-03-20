#!/usr/bin/env bash
# extract-fix-patterns.sh — Extract bug fix patterns from git history
# Usage: extract-fix-patterns.sh [repo-path] [max-commits]
#
# Searches git log for fix/bug commits and outputs structured patterns.
# Used by interview skill Phase 2 to populate knowledge-base/bug-patterns.md

set -euo pipefail

REPO_PATH="${1:-.}"
MAX_COMMITS="${2:-500}"

if [ ! -d "$REPO_PATH/.git" ]; then
  echo "Error: $REPO_PATH is not a git repository" >&2
  exit 1
fi

cd "$REPO_PATH"

echo "## Fix Patterns Extracted from Git History"
echo ""
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Repository: $(git remote get-url origin 2>/dev/null || echo 'local')"
echo "Commits analyzed: up to $MAX_COMMITS"
echo ""

# Extract commits with fix/bug keywords
echo "### Fix Commits"
echo ""
git log --oneline --all -n "$MAX_COMMITS" \
  --grep='fix' --grep='bug' --grep='hotfix' --grep='patch' \
  --grep='resolve' --grep='Fixed:' --grep='Fixes:' \
  --or \
  --format='- **%h** %s (%ai)' 2>/dev/null | head -200 || true

echo ""
echo "### Files Most Frequently Fixed"
echo ""
# Top 20 files appearing in fix commits
git log --all -n "$MAX_COMMITS" \
  --grep='fix\|bug\|hotfix\|patch' -i \
  --diff-filter=M --name-only --format='' 2>/dev/null \
  | sort | uniq -c | sort -rn | head -20 \
  | while read -r count file; do
    echo "- **$file** ($count fixes)"
  done || true

echo ""
echo "### Fix Frequency by Directory"
echo ""
git log --all -n "$MAX_COMMITS" \
  --grep='fix\|bug\|hotfix\|patch' -i \
  --diff-filter=M --name-only --format='' 2>/dev/null \
  | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -15 \
  | while read -r count dir; do
    echo "- **$dir/** ($count fixes)"
  done || true
