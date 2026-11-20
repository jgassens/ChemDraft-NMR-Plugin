import type { PluginManifest } from "@chemdraft/plugin-api";

export const nmrPredictorPluginId = "org.chemdraft.nmr.predictor";

/** ¹³C is the default nucleus; ¹H is a separate, experimental command (ADR-0011: value-encoded
 *  commands, not an argument channel). Handlers are wired in M8. */
export const nmrPredictCarbonCommandId = "plugin.nmrPredictor.predictSelectedStructure";
export const nmrPredictProtonCommandId = "plugin.nmrPredictor.predictWithProtonExperimental";
export const nmrPredictPhosphorusCommandId = "plugin.nmrPredictor.predictPhosphorus";
export const nmrPredictorPanelId = "panel.nmrPredictor.review";
export const nmrPredictorAnalyzerId = "plugin.nmrPredictor.forwardPrediction";

/** analysisType stamped on records written to the generic analysis store (M8). */
export const nmrForwardPredictionAnalysisType = "nmr.forward-prediction";

export const nmrPredictorManifest: PluginManifest = {
  id: nmrPredictorPluginId,
  name: "NMR Shift Predictor",
  version: "0.3.0",
  apiVersion: "^0.1.25",
  license: "MIT",
  description:
    "HOSE-fragment NMR shift prediction using NMRShiftDB2 assignments for ¹H/¹³C and Ilm-NMR-P31 assignments for ³¹P. NMRShiftDB2 does not identify which assignments are experimental. Applicable ¹H/¹³C rule estimates are labeled. Omitted environments carry a warning. ¹H multiplicity and couplings are first-order topology-based estimates. Stick height represents the predicted number of equivalent nuclei.",
  entry: "dist/plugin.js",
  permissions: ["selection.read", "analysis.write", "ui.menu", "ui.panel"],
  contributes: {
    commands: [
      {
        id: nmrPredictCarbonCommandId,
        title: "Predict ¹³C NMR Shifts",
        category: "Analyze",
        description:
          "Predict ¹³C shifts for the selected structure by HOSE-fragment lookup over NMRShiftDB2-derived statistics.",
        requiredPermissions: ["selection.read", "analysis.write"],
        enabled: true
      },
      {
        id: nmrPredictProtonCommandId,
        title: "Predict ¹H NMR Shifts (experimental)",
        category: "Analyze",
        description: "Experimental ¹H prediction; labile protons are omitted by default.",
        requiredPermissions: ["selection.read", "analysis.write"],
        enabled: true
      },
      {
        id: nmrPredictPhosphorusCommandId,
        title: "Predict ³¹P NMR Shifts",
        category: "Analyze",
        description: "Predict ³¹P shifts for the selected structure by HOSE-fragment lookup over Ilm-NMR-P31-derived statistics.",
        requiredPermissions: ["selection.read", "analysis.write"],
        enabled: true
      }
    ],
    menus: [
      {
        id: "menu.nmrPredictor.predictCarbon",
        title: "Predict ¹³C NMR Shifts",
        commandId: nmrPredictCarbonCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      },
      {
        id: "menu.nmrPredictor.predictProton",
        title: "Predict ¹H NMR Shifts (experimental)",
        commandId: nmrPredictProtonCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      },
      {
        id: "menu.nmrPredictor.predictPhosphorus",
        title: "Predict ³¹P NMR Shifts",
        commandId: nmrPredictPhosphorusCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],
    panels: [
      {
        id: nmrPredictorPanelId,
        title: "NMR Prediction",
        commandId: nmrPredictCarbonCommandId,
        requiredPermissions: ["ui.panel"]
      }
    ],
    analyzers: [
      {
        id: nmrPredictorAnalyzerId,
        title: "NMR Forward Prediction",
        commandId: nmrPredictCarbonCommandId,
        requiredPermissions: ["selection.read", "analysis.write"]
      }
    ],
    toolbarButtons: [],
    toolsets: [],
    inspectors: [],
    templates: [],
    importers: [],
    exporters: [],
    transformers: [],
    recognizers: []
  }
};
