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
- the exact rehearsal history toolchain, including Node/Git/Python/uv/filter-repo versions and executable-wrapper digest

The importer must validate the exact toolchain and pinned objects before rewriting anything. Replacement refs/grafts/alternates, a changed default ref or tag object, an added/removed tag name, a pre-existing target tag/output ref, a reserved target evidence path, or a source-target path collision stops the locked run. Refreshing this file is a separate reviewed change. `--source-root` accepts retained `<source-name>.git` mirrors so the manifest-URL and offline-local paths can be compared byte-for-byte.

Path rewriting adds only the source's `destinationPrefix`. Imported tags remain on those prefixed historical commits. The `moves` list applies afterward on the assembled migration branch, so stripping the prefix from a tagged tree yields the original source paths and contents.

Commit and tag signatures cannot remain cryptographically valid after path or tag-name rewriting changes their object IDs. The original object IDs, signature presence, and old-to-new commit maps are retained as provenance; the importer must not present rewritten objects as signed.
