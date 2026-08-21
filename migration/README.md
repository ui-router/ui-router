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

Before the official run, H01 creates reviewed `execution-lock.json` beside this manifest on a control branch rooted at the exact target base. It binds that base, manifest digest, source refs/objects, toolchain, vendored filter-repo artifact, wrapper, retained mirrors, and complete offline Git bundles by digest. Baseline and package-classification contracts bind the execution-lock digest; they do not feed back into it. The importer must require and validate this acyclic control set before rewriting anything, then copy its exact bytes into the deterministic evidence commit rather than merging the control commits ahead of their locked base. Replacement refs/grafts/alternates, target-base drift, a changed default ref or tag object, an added/removed tag name, a pre-existing target tag/output ref, any reserved control/evidence destination, a base `sources.json` byte mismatch, or a source-target path collision stops the locked run. Refreshing an input is a separate reviewed change that invalidates dependents. `--source-root` accepts validated `<source-name>.git` repositories restored from retained mirrors or hashed bundles so remote, mirror, and offline-bundle paths can be compared byte-for-byte.

Path rewriting adds only the source's `destinationPrefix`. Imported tags remain on those prefixed historical commits. The `moves` list applies afterward on the assembled migration branch, so stripping the prefix from a tagged tree yields the original source paths and contents.

Commit and tag signatures cannot remain cryptographically valid after path or tag-name rewriting changes their object IDs. The original object IDs, signature presence, and old-to-new commit maps are retained as provenance; the importer must not present rewritten objects as signed. Rewritten annotated tags retain their ordered non-signature headers and unsigned message while changing only the target object/name and removing invalid signature material.
