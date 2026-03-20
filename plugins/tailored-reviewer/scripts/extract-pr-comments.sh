#!/usr/bin/env bash
# extract-pr-comments.sh — Extract PR review comments via GitHub API
# Usage: extract-pr-comments.sh <owner/repo> [max-prs]
#
# Extracts review comments from recent PRs to identify reviewer patterns.
# Used by interview skill Phase 2 to populate knowledge-base/pr-review-patterns.md
# Requires: gh CLI authenticated

set -euo pipefail

REPO="${1:?Usage: extract-pr-comments.sh <owner/repo> [max-prs]}"
MAX_PRS="${2:-50}"

if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI is not installed" >&2
  exit 1
fi

echo "## PR Review Patterns"
echo ""
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Repository: $REPO"
echo "PRs analyzed: up to $MAX_PRS"
echo ""

# Get recent merged PRs
PR_NUMBERS=$(gh api "repos/$REPO/pulls?state=closed&sort=updated&direction=desc&per_page=$MAX_PRS" \
  --jq '.[] | select(.merged_at != null) | .number' 2>/dev/null) || {
  echo "Error: Failed to fetch PRs from $REPO" >&2
  exit 1
}

TOTAL_COMMENTS=0
REVIEWER_COUNTS=""

for PR_NUM in $PR_NUMBERS; do
  COMMENTS=$(gh api "repos/$REPO/pulls/$PR_NUM/comments" --jq '.[] | {
    reviewer: .user.login,
    path: .path,
    body: .body,
    created_at: .created_at
  }' 2>/dev/null) || continue

  if [ -n "$COMMENTS" ]; then
    COMMENT_COUNT=$(echo "$COMMENTS" | grep -c '"reviewer"' || true)
    TOTAL_COMMENTS=$((TOTAL_COMMENTS + COMMENT_COUNT))

    # Collect reviewer names
    REVIEWERS=$(echo "$COMMENTS" | grep '"reviewer"' | sed 's/.*"reviewer": "\([^"]*\)".*/\1/' || true)
    REVIEWER_COUNTS="$REVIEWER_COUNTS
$REVIEWERS"
  fi

  # Rate limit protection
  sleep 0.5
done

echo "### Summary"
echo ""
echo "- Total review comments analyzed: $TOTAL_COMMENTS"
echo ""

echo "### Most Active Reviewers"
echo ""
echo "$REVIEWER_COUNTS" | sort | uniq -c | sort -rn | head -10 \
  | while read -r count reviewer; do
    [ -n "$reviewer" ] && echo "- **$reviewer** ($count comments)"
  done || true

echo ""
echo "### Most Reviewed Paths"
echo ""
for PR_NUM in $(echo "$PR_NUMBERS" | head -20); do
  gh api "repos/$REPO/pulls/$PR_NUM/comments" --jq '.[].path' 2>/dev/null || true
  sleep 0.3
done | sort | uniq -c | sort -rn | head -15 \
  | while read -r count path; do
    echo "- **$path** ($count comments)"
  done || true
