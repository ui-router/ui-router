#!/usr/bin/env bash
# monorepo.sh - Create monorepo using git-filter-repo

set -e  # Exit on error

# Configuration
git config --global user.email "github@sandgnat.com"
git config --global user.name "Chris Thielen"

MONOREPO_NAME="ui-router"
SOURCE_DIR="$(pwd)"
REPOS="publish-scripts core angularjs angular angular-hybrid react react-hybrid dsr rx redux sticky-states visualizer sample-app-angular sample-app-angular-hybrid sample-app-angularjs sample-app-react"
# REPOS="publish-scripts core angularjs"  # Use this line for testing with 3 repos

# Check prerequisites
if ! command -v git-filter-repo &> /dev/null; then
    echo "Error: git-filter-repo not installed"
    echo "Install with: brew install git-filter-repo"
    exit 1
fi

# Create temporary directory
TEMP_BASE=$(mktemp -d)
echo "=== Step 1: Filtering repositories ==="

# Filter each repo
for REPO in $REPOS; do
    echo "Filtering $REPO..."
    SOURCE_PATH="$SOURCE_DIR/$REPO"
    TEMP_DIR="$TEMP_BASE/$REPO"

    git clone --quiet "$SOURCE_PATH" "$TEMP_DIR"
    cd "$TEMP_DIR"

    # Rewrite paths and prefix tags
    git filter-repo \
        --to-subdirectory-filter "packages/$REPO" \
        --tag-rename "":"${REPO}-" \
        --force --quiet

    echo "✓ $REPO filtered"
done

# Determine chronological order by first commit
echo ""
echo "=== Step 2: Determining import order ==="
REPO_ORDER=$(mktemp)
for REPO in $REPOS; do
    cd "$TEMP_BASE/$REPO"
    FIRST_DATE=$(git log --reverse --format='%ct' | head -1)
    echo "$FIRST_DATE $REPO"
    echo "$FIRST_DATE $REPO" >> "$REPO_ORDER"
done
sort -n "$REPO_ORDER" | cut -d' ' -f2 > "${REPO_ORDER}.sorted"

# Create monorepo
echo ""
echo "=== Step 3: Creating monorepo ==="
cd "$SOURCE_DIR"
mkdir "$MONOREPO_NAME"
cd "$MONOREPO_NAME"
git init --quiet
git branch -m main

# Create initial commit
cat > package.json << 'EOF'
{
  "name": "ui-router-monorepo",
  "version": "1.0.0",
  "private": true,
  "workspaces": {
    "packages": ["packages/*"],
    "nohoist": ["**/jest", "**/@jest/**"]
  }
}
EOF

echo "node_modules" > .gitignore
git add .
git commit --quiet -m "chore: initialize monorepo"

echo ""
echo "=== Step 4: Importing repositories ==="

# Import each repo in order
while read REPO; do
    echo "Importing $REPO..."

    # Add remote and fetch
    git remote add "temp-$REPO" "$TEMP_BASE/$REPO"
    git fetch --quiet "temp-$REPO" --tags

    # Get the filtered branch
    BRANCH=$(cd "$TEMP_BASE/$REPO" && git branch --show-current)

    # Merge with --allow-unrelated-histories (creates merge commit but preserves all history)
    git merge "temp-$REPO/$BRANCH" --allow-unrelated-histories --no-edit -m "chore: import $REPO

Imports complete history from $REPO into packages/$REPO
Source: $SOURCE_DIR/$REPO"

    # Remove temp remote
    git remote remove "temp-$REPO"

    TOTAL=$(git log --oneline | wc -l | tr -d ' ')
    echo "✓ $REPO imported ($TOTAL total commits)"
done < "${REPO_ORDER}.sorted"

# Cleanup
rm -rf "$TEMP_BASE"
rm -f "$REPO_ORDER" "${REPO_ORDER}.sorted"

echo ""
echo "=== Step 5: Setting up workspaces ==="
find packages -name "yarn.lock" -type f -delete 2>/dev/null || true
yarn install 2>&1 | grep -v "^warning" || echo "(yarn install issues - expected with Node 16)"
git add . 2>/dev/null
git commit --quiet -m "chore: initialize yarn workspaces" 2>/dev/null || true

echo ""
echo "=== Step 6: Configuring Changesets ==="
yarn add -D @changesets/cli 2>&1 | grep -v "^warning" || echo "(changesets install issues - expected with Node 16)"
npx changeset init 2>/dev/null || true

if [ -d ".changeset" ]; then
    cat > .changeset/config.json << 'EOF'
{
  "$schema": "https://unpkg.com/@changesets/config@2.3.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
EOF
fi

git add . 2>/dev/null
git commit --quiet -m "chore: configure changesets" 2>/dev/null || true

echo ""
echo "=== ✓ Monorepo created successfully ==="
echo ""
echo "Location: $(pwd)"
echo "Total commits: $(git log --oneline | wc -l | tr -d ' ')"
echo "Total packages: $(ls -1 packages 2>/dev/null | wc -l | tr -d ' ')"
echo "No nested .git: $(find packages -name '.git' -type d | wc -l | tr -d ' ') (should be 0)"
echo ""
echo "Run './verify-monorepo.sh' to verify the import"
