/**
 * The ¹⁹F predictor's bundled data: the ¹⁹F model's training domain and the gate HOSE table. Both are
 * NMRexp-derived (CC BY 4.0; see `model-19F/NMREXP_LICENSE.md`).
 *
 * This module is only ever imported dynamically, on the first ¹⁹F prediction of a CF3 molecule, so
 * ¹H/¹³C/³¹P predictions never load it and the packaging build emits it as its own chunk.
 */
import type { GnnTrainingDomain } from "../domainRules";
import trainingDomain from "../model-19F/domain.json";
import gateTable from "../model-19F/hose-table.json";
import type { F19HoseTable } from "./hoseTable";

export interface F19Assets {
  domain: GnnTrainingDomain;
  table: F19HoseTable;
}

export const F19_ASSETS: F19Assets = {
  domain: trainingDomain as unknown as GnnTrainingDomain,
  table: gateTable as unknown as F19HoseTable
};
