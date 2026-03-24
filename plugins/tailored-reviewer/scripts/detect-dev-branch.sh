#!/usr/bin/env bash
# detect-dev-branch.sh — Detect the actual primary development branch
# Usage: detect-dev-branch.sh <owner/repo>
#
# Many projects use a branch other than the GitHub default (e.g., develop, dev)
# as their primary development branch, with the default branch reserved for releases.
# This script gathers evidence to detect such cases.
#
# Output: Structured report with 3 signals for AI to interpret

set -euo pipefail

REPO="${1:?Usage: detect-dev-branch.sh <owner/repo>}"
MAX_PRS="${2:-100}"

# Get GitHub default branch
DEFAULT_BRANCH=$(gh api "repos/$REPO" --jq '.default_branch' 2>/dev/null)
if [ -z "$DEFAULT_BRANCH" ]; then
  echo "Error: Could not fetch repository info for $REPO" >&2
  exit 1
fi

echo "## Development Branch Detection Report"
echo ""
echo "Repository: $REPO"
echo "GitHub default branch: $DEFAULT_BRANCH"
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Candidate development branch names
CANDIDATES=("develop" "development" "dev" "staging" "next" "trunk")

# Find which candidates exist
EXISTING=()
for branch in "${CANDIDATES[@]}"; do
  if gh api "repos/$REPO/branches/$branch" --jq '.name' 2>/dev/null >/dev/null; then
    EXISTING+=("$branch")
  fi
done

if [ ${#EXISTING[@]} -eq 0 ]; then
  echo "### Result: No Alternative Development Branches Found"
  echo ""
  echo "No candidate branches (develop, development, dev, staging, next, trunk) exist."
  echo "Recommended branch: **$DEFAULT_BRANCH**"
  exit 0
fi

echo "### Signal 1: PR Base Branch Distribution (recent $MAX_PRS merged PRs)"
echo ""
gh api "repos/$REPO/pulls?state=closed&sort=updated&direction=desc&per_page=$MAX_PRS" \
  --jq '
    [.[] | select(.merged_at != null)]
    | group_by(.base.ref)
    | map({branch: .[0].base.ref, count: length})
    | sort_by(-.count)
    | .[]
    | "- \(.branch): \(.count) PRs"
  ' 2>/dev/null || echo "- (could not fetch PR data)"

echo ""
echo "### Signal 2: Commit Recency"
echo ""

# Default branch latest commit
DEFAULT_DATE=$(gh api "repos/$REPO/commits?sha=$DEFAULT_BRANCH&per_page=1" \
  --jq '.[0].commit.committer.date' 2>/dev/null || echo "unknown")
DEFAULT_MSG=$(gh api "repos/$REPO/commits?sha=$DEFAULT_BRANCH&per_page=1" \
  --jq '.[0].commit.message | split("\n")[0] | .[:80]' 2>/dev/null || echo "unknown")
echo "- $DEFAULT_BRANCH (default): $DEFAULT_DATE — $DEFAULT_MSG"

for branch in "${EXISTING[@]}"; do
  BRANCH_DATE=$(gh api "repos/$REPO/commits?sha=$branch&per_page=1" \
    --jq '.[0].commit.committer.date' 2>/dev/null || echo "unknown")
  BRANCH_MSG=$(gh api "repos/$REPO/commits?sha=$branch&per_page=1" \
    --jq '.[0].commit.message | split("\n")[0] | .[:80]' 2>/dev/null || echo "unknown")
  echo "- $branch: $BRANCH_DATE — $BRANCH_MSG"
done

echo ""
echo "### Signal 3: Commit Divergence (ahead/behind vs default)"
echo ""

for branch in "${EXISTING[@]}"; do
  COMPARE=$(gh api "repos/$REPO/compare/$DEFAULT_BRANCH...$branch" \
    --jq '"\(.ahead_by) commits ahead, \(.behind_by) commits behind (status: \(.status))"' \
    2>/dev/null || echo "could not compare")
  echo "- $branch vs $DEFAULT_BRANCH: $COMPARE"
done

echo ""
echo "### Interpretation Guide"
echo ""
echo "Strong indicators that a non-default branch is the primary development branch:"
echo "- It receives >50% of merged PRs"
echo "- Its latest commit is significantly more recent than the default branch (>90 days gap)"
echo "- It is many commits ahead of the default branch with 0 behind"
echo ""
echo "If 2+ signals point to the same branch, recommend it as the primary development branch."
