#!/usr/bin/env node

import {
  validatePackageArtifactsContract,
  validatePackageArtifactsEvidence,
} from "./package-artifacts-lib.mjs";

try {
  const { contract, productionEdges } =
    await validatePackageArtifactsContract();
  await validatePackageArtifactsEvidence({ contract });
  const entrypoints = contract.packages.reduce(
    (count, record) => count + record.entrypoints.length,
    0
  );
  console.log(
    `PACKAGE_ARTIFACTS_VERIFY_OK packages=${contract.packages.length} builds=${
      contract.packages.filter((record) => record.build).length
    } edges=${productionEdges.length} entrypoints=${entrypoints} repetitions=${
      contract.artifactPolicy.repetitions
    }`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
