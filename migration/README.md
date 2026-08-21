# History migration inputs

`sources.json` is the immutable source snapshot for the UI-Router history import.

For each source it records:

- source URL, default branch, pinned branch head and tree
- destination namespace and tag namespace
- every observed tag object and peeled commit/tree
- the package-release tags selected by the migration policy
- excluded tags and the evidence for exclusion
- explicit current-layout moves applied only after the source history is merged
- the count of signature-bearing default-branch commits

The importer must validate pinned objects before rewriting anything. A changed default ref, changed tag object, or added/removed tag name stops the locked run. Refreshing this file is a separate reviewed change.

Path rewriting adds only the source's `destinationPrefix`. Imported tags remain on those prefixed historical commits. The `moves` list applies afterward on the assembled migration branch, so stripping the prefix from a tagged tree yields the original source paths and contents.

Commit and tag signatures cannot remain cryptographically valid after path or tag-name rewriting changes their object IDs. The original object IDs, signature presence, and old-to-new commit maps are retained as provenance; the importer must not present rewritten objects as signed.
