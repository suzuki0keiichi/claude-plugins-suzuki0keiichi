#!/usr/bin/env bash
# health-metrics.sh — Collect mechanical code health metrics
# Usage: health-metrics.sh [repo-path]
#
# Collects deterministic metrics: complexity, churn, test coverage, dead code.
# Used by health-score skill. LLM interprets these numbers, not this script.

set -euo pipefail

REPO_PATH="${1:-.}"

if [ ! -d "$REPO_PATH/.git" ]; then
  echo "Error: $REPO_PATH is not a git repository" >&2
  exit 1
fi

cd "$REPO_PATH"

echo "## Health Metrics"
echo ""
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Repository: $(git remote get-url origin 2>/dev/null || echo 'local')"
echo ""

echo "### File Churn (last 30 days)"
echo ""
echo "Top 20 most frequently changed files:"
echo ""
git log --since="30 days ago" --diff-filter=M --name-only --format='' 2>/dev/null \
  | sort | uniq -c | sort -rn | head -20 \
  | while read -r count file; do
    echo "- **$file** ($count changes)"
  done || echo "(no changes in last 30 days)"

echo ""
echo "### Directory Churn (last 30 days)"
echo ""
git log --since="30 days ago" --diff-filter=M --name-only --format='' 2>/dev/null \
  | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -15 \
  | while read -r count dir; do
    echo "- **$dir/** ($count changes)"
  done || echo "(no changes in last 30 days)"

echo ""
echo "### Large Files (potential complexity indicators)"
echo ""
find . -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
       -o -name '*.py' -o -name '*.rb' -o -name '*.go' -o -name '*.rs' \
       -o -name '*.java' -o -name '*.kt' -o -name '*.swift' \
       -o -name '*.c' -o -name '*.cpp' -o -name '*.h' 2>/dev/null \
  | grep -v node_modules | grep -v vendor | grep -v '.git' \
  | while read -r f; do
    lines=$(wc -l < "$f" 2>/dev/null || echo 0)
    echo "$lines $f"
  done | sort -rn | head -20 \
  | while read -r lines file; do
    echo "- **$file** ($lines lines)"
  done || echo "(no source files found)"

echo ""
echo "### Test Coverage Indicator"
echo ""
TEST_FILES=$(find . -type f \( -name '*test*' -o -name '*spec*' -o -name '*_test.*' \) 2>/dev/null \
  | { grep -v node_modules | grep -v vendor | grep -v '.git' || true; } | wc -l | tr -d ' ')
SRC_FILES=$(find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
       -o -name '*.py' -o -name '*.rb' -o -name '*.go' \) 2>/dev/null \
  | { grep -v node_modules | grep -v vendor | grep -v '.git' \
  | grep -v test | grep -v spec || true; } | wc -l | tr -d ' ')
echo "- Test files: $TEST_FILES"
echo "- Source files (non-test): $SRC_FILES"
if [ "$SRC_FILES" -gt 0 ]; then
  RATIO=$(echo "scale=1; $TEST_FILES * 100 / $SRC_FILES" | bc 2>/dev/null || echo "N/A")
  echo "- Test-to-source ratio: ${RATIO}%"
fi

echo ""
echo "### Recent Fix Frequency (last 30 days)"
echo ""
FIX_COUNT=$({ git log --since="30 days ago" --oneline \
  --grep='fix' --grep='bug' --grep='hotfix' -i --or 2>/dev/null || true; } | wc -l | tr -d ' ')
TOTAL_COUNT=$({ git log --since="30 days ago" --oneline 2>/dev/null || true; } | wc -l | tr -d ' ')
echo "- Fix-related commits: $FIX_COUNT / $TOTAL_COUNT total"
if [ "$TOTAL_COUNT" -gt 0 ]; then
  FIX_RATIO=$(echo "scale=1; $FIX_COUNT * 100 / $TOTAL_COUNT" | bc 2>/dev/null || echo "N/A")
  echo "- Fix ratio: ${FIX_RATIO}%"
fi
