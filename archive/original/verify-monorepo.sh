#!/usr/bin/env bash
# verify-monorepo.sh - Verification script for monorepo migration

set -e

MONOREPO_DIR="ui-router"
SOURCE_DIR=$(dirname "$(pwd)")

if [ ! -d "$MONOREPO_DIR" ]; then
    echo "Error: $MONOREPO_DIR directory not found"
    echo "Run monorepo.sh first to create the monorepo"
    exit 1
fi

cd "$MONOREPO_DIR"

echo "=== Monorepo Verification ==="
echo ""

# 1. Basic structure check
echo "1. Directory Structure:"
echo "   Packages found: $(ls -1 packages 2>/dev/null | wc -l | tr -d ' ')"
ls -1 packages
echo ""

# 2. Check for nested .git directories
echo "2. Nested .git directories check:"
NESTED_GIT=$(find packages -name ".git" -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$NESTED_GIT" -eq 0 ]; then
    echo "   ✓ No nested .git directories found"
else
    echo "   ✗ Found $NESTED_GIT nested .git directories:"
    find packages -name ".git" -type d
fi
echo ""

# 3. Total commit count
echo "3. Total commits in monorepo: $(git rev-list --all --count)"
echo ""

# 4. Commit count per package (sample)
echo "4. Commit counts for first 3 packages:"
for repo in publish-scripts core angularjs; do
    if [ -d "packages/$repo" ]; then
        MONO_COUNT=$(git rev-list --all --count -- "packages/$repo" 2>/dev/null || echo "0")
        echo "   $repo: $MONO_COUNT commits"
    fi
done
echo ""

# 5. Workspace verification
echo "5. Yarn workspaces:"
if command -v yarn &> /dev/null; then
    yarn workspaces list 2>/dev/null | head -10
    echo "   (showing first 10)"
else
    echo "   Yarn not found, skipping workspace check"
fi
echo ""

# 6. Tag verification (sample)
echo "6. Tags (sample of first 10):"
git tag | head -10
echo "   Total tags: $(git tag | wc -l | tr -d ' ')"
echo ""

# 7. Changesets verification
echo "7. Changesets configuration:"
if [ -d ".changeset" ]; then
    echo "   ✓ .changeset directory exists"
    if [ -f ".changeset/config.json" ]; then
        echo "   ✓ config.json exists"
    else
        echo "   ✗ config.json missing"
    fi
else
    echo "   ✗ .changeset directory not found"
fi
echo ""

# 8. Summary
echo "=== Summary ==="
echo "Location: $(pwd)"
echo "Total commits: $(git rev-list --all --count)"
echo "Total packages: $(ls -1 packages 2>/dev/null | wc -l | tr -d ' ')"
echo "Total tags: $(git tag | wc -l | tr -d ' ')"
echo "Changesets: $([ -d '.changeset' ] && echo 'configured' || echo 'not configured')"
