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

Before the official run, H01 creates reviewed `execution-lock.json` beside this manifest on a control branch rooted at the exact target base. It binds that base, manifest digest, source refs/objects, toolchain/runtime, vendored filter-repo artifact, local-only wrapper, pinned contract validator, retained mirrors, and complete offline Git bundles by digest. Baseline and package-classification contracts bind the execution-lock digest; they do not feed back into it. The importer must require and validate this acyclic control set before rewriting anything, then copy its exact bytes into the deterministic evidence commit rather than merging the control commits ahead of their locked base. Replacement refs/grafts/alternates, target-base drift, a changed default ref or tag object, an added/removed tag name, a pre-existing target tag/output ref, any reserved control/evidence destination, a base `sources.json` byte mismatch, or a source/target/post-move path collision stops the locked run. Refreshing an input is a separate reviewed change that invalidates dependents. Explicit `remote`, `mirror`, and `bundle` source modes consume the same lock and must produce byte-identical outputs.

## H01 interface

`tools/lock-history-inputs.mjs` never runs source package or lifecycle scripts. In `generate` mode it requires an immutable target base, fresh-clones all source remotes, refreshes the manifest facts, prunes retained mirrors to the exact default/tag ref allowlist, creates and restores complete bundles, writes compact execution evidence, and emits `migration/execution-lock.json`. It refuses to overwrite an existing lock, mirror root, bundle root, or execution-evidence root. `check` mode rehashes and revalidates the retained inputs without regenerating them.

The filter-repo artifact must already be retained under the control root and its digest approved before generation. `--write-filter-repo-wrapper` creates the only accepted wrapper shape: the locked absolute Python executable running that exact local artifact. The tool requires reviewed digests for the artifact, deterministic wrapper template, validator, and Python executable before any version probe; it rejects any other wrapper bytes and never resolves `uvx`, a registry, or a mutable cache. The execution lock also binds the complete `migration/schemas/` tree digest before contract validation.

## A01 source-checkout recovery acceptance

The original H01 mirrors and bundle files are the preferred offline reproduction inputs. If those derived archive files are unavailable after the import, A01 may use the maintainer-approved `source-checkouts` recovery mode instead. It checks the sibling source checkouts named by `migration/sources.json`, verifies that each locked default-head object is present locally, and verifies every locked tag object locally or, only when absent locally, against that checkout's `origin` remote. This proves that the source history needed to reconstruct the import remains available; it does not claim that the original byte-identical H01 bundle files were recovered.

```bash
node tools/lock-history-inputs.mjs \
  --mode generate \
  --control-root "$PWD" \
  --base <merged-tooling-main-commit> \
  --decision-date YYYY-MM-DD \
  --node-lts-line <latest-LTS-major-resolved-on-that-date> \
  --filter-repo-artifact .migration-work/artifacts/git_filter_repo.py \
  --filter-repo-artifact-sha256 <pre-reviewed-artifact-digest> \
  --filter-repo-wrapper .migration-work/bin/git-filter-repo \
  --filter-repo-wrapper-sha256 <pre-reviewed-template-digest> \
  --filter-repo-package-version 2.47.0 \
  --schema-validator-artifact tools/validate-migration-contract.mjs \
  --schema-validator-sha256 <pre-reviewed-validator-digest> \
  --python-executable <absolute-non-symlink-python-path> \
  --python-executable-sha256 <pre-reviewed-python-digest> \
  --os-image <immutable-image-name> \
  --os-image-digest <immutable-image-digest> \
  --retention-owner <owner> \
  --write-filter-repo-wrapper
```

Before H02, add reviewed `migration/baselines.json`, `migration/package-classification.json`, and every referenced compact file under `migration/control-evidence/`; each dependent contract must bind the lock/manifest digest chain. Then run `check` with the same arguments plus `--execution-lock-sha256 <separately-reviewed-digest>` and execute/import/verify all three source modes. Check, import, and verify never infer that digest from the file it is intended to authenticate; the importer and verifier also require explicit manifest, execution-lock, control-root, and source-mode arguments.

Path rewriting adds only the source's `destinationPrefix`. Imported tags remain on those prefixed historical commits. The `moves` list applies afterward on the assembled migration branch, so stripping the prefix from a tagged tree yields the original source paths and contents.

Commit and tag signatures cannot remain cryptographically valid after path or tag-name rewriting changes their object IDs. The original object IDs, signature presence, and old-to-new commit maps are retained as provenance; the importer must not present rewritten objects as signed. Rewritten annotated tags retain their ordered non-signature headers and unsigned message while changing only the target object/name and removing invalid signature material.
