#!/usr/bin/env bash
#
# Transfer all OPEN issues from aind-data-schema to biodata-schema,
# except issue #1870, using GitHub's native issue-transfer functionality
# (GraphQL transferIssue mutation).
#
# Requirements (already verified):
#   - gh CLI authenticated with `repo` scope
#   - push/admin access to BOTH repos
#   - both repos owned by the same org (AllenNeuralDynamics)
#
# Usage:
#   ./transfer_issues.sh            # dry run: lists what would move
#   ./transfer_issues.sh --execute  # actually transfer

set -euo pipefail

SRC_OWNER="AllenNeuralDynamics"
SRC_REPO="aind-data-schema"
DST_OWNER="AllenNeuralDynamics"
DST_REPO="biodata-schema"
EXCLUDE=(1870)

EXECUTE=false
[[ "${1:-}" == "--execute" ]] && EXECUTE=true

# --- resolve the destination repository node id -------------------------------
DST_ID=$(gh api graphql -f query='
  query($owner:String!, $name:String!) {
    repository(owner:$owner, name:$name) { id }
  }' -f owner="$DST_OWNER" -f name="$DST_REPO" --jq '.data.repository.id')

echo "Destination repo node id: $DST_ID"

# --- collect open issues (excludes PRs automatically) -------------------------
ISSUES=()
while IFS= read -r line; do
  ISSUES+=("$line")
done < <(
  gh issue list -R "$SRC_OWNER/$SRC_REPO" --state open --limit 1000 \
    --json number,id,title \
    --jq '.[] | "\(.number)\t\(.id)\t\(.title)"'
)

echo "Found ${#ISSUES[@]} open issue(s)."

is_excluded() {
  local n="$1"
  for e in "${EXCLUDE[@]}"; do [[ "$n" == "$e" ]] && return 0; done
  return 1
}

count=0
for line in "${ISSUES[@]}"; do
  IFS=$'\t' read -r number id title <<< "$line"
  if is_excluded "$number"; then
    echo "SKIP  #$number  $title"
    continue
  fi

  if $EXECUTE; then
    new_url=$(gh api graphql -f query='
      mutation($issueId:ID!, $repoId:ID!) {
        transferIssue(input:{issueId:$issueId, repositoryId:$repoId}) {
          issue { url }
        }
      }' -f issueId="$id" -f repoId="$DST_ID" \
      --jq '.data.transferIssue.issue.url')
    echo "MOVED #$number -> $new_url"
    # gentle pacing to stay well under secondary rate limits
    sleep 2
  else
    echo "WOULD MOVE #$number  $title"
  fi
  count=$((count+1))
done

echo "----"
if $EXECUTE; then
  echo "Transferred $count issue(s)."
else
  echo "Dry run: $count issue(s) would be transferred. Re-run with --execute to perform."
fi
