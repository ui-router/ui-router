#!/usr/bin/env node

import { validateIntegrationMatrix } from "./integration-matrix-lib.mjs";

const result = await validateIntegrationMatrix();
console.log(
  `INTEGRATION_MATRIX_OK projects=${result.matrix.counts.projects} runnable=${result.matrix.counts.runnable} templates=${result.matrix.counts.templates} browser=${result.matrix.counts.browserProjects} edges=${result.matrix.counts.logicalEdges} rewrites=${result.matrix.counts.rewriteOperations} artifacts=${result.matrix.counts.artifactIds}`
);
