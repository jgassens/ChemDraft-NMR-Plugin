import type { PluginManifest } from "@chemdraft/plugin-api";

export const nmrPredictorPluginId = "org.chemdraft.nmr.predictor";

/** ¹³C is the default nucleus; ¹H is a separate, experimental command (ADR-0011: value-encoded
 *  commands, not an argument channel). Handlers are wired in M8. */
export const nmrPredictCarbonCommandId = "plugin.nmrPredictor.predictSelectedStructure";
export const nmrPredictProtonCommandId = "plugin.nmrPredictor.predictWithProtonExperimental";
export const nmrPredictPhosphorusCommandId = "plugin.nmrPredictor.predictPhosphorus";
/** ¹⁹F, CF3 only in this version (docs/f19-benchmark.md §6). */
export const nmrPredictFluorineCommandId = "plugin.nmrPredictor.predictFluorine";
export const nmrPredictorPanelId = "panel.nmrPredictor.review";
export const nmrPredictorAnalyzerId = "plugin.nmrPredictor.forwardPrediction";

/** analysisType stamped on records written to the generic analysis store (M8). */
export const nmrForwardPredictionAnalysisType = "nmr.forward-prediction";

export const nmrPredictorManifest: PluginManifest = {
  id: nmrPredictorPluginId,
  name: "NMR Shift Predictor",
  version: "0.4.0",
  apiVersion: "^0.1.25",
  license: "MIT",
  description:
    "¹H/¹³C shifts from a graph neural network (GNN) trained on NMRShiftDB2 assignments, run locally from model files bundled in the plugin, with HOSE-fragment lookup over NMRShiftDB2 statistics as cross-check and fallback; ³¹P shifts by HOSE-fragment lookup over Ilm-NMR-P31 assignments; ¹⁹F shifts for CF3 groups only, from a GNN trained on NMRexp data (Wang and Zhu, Zenodo doi:10.5281/zenodo.17296666, CC BY 4.0) with HOSE-fragment lookup over NMRexp statistics as cross-check and fallback (NMRShiftDB2 was used only to test it). NMRShiftDB2 does not identify which assignments are experimental. Each shift is labeled GNN prediction or HOSE lookup; GNN predictions carry a high, medium or low tier. Applicable ¹H/¹³C rule estimates are labeled. Omitted environments carry a warning. ¹H multiplicity and couplings are first-order topology-based estimates. Stick height represents the predicted number of equivalent nuclei.",
  entry: "dist/plugin.js",
  // model.load: the bundled GNN model files are loaded (lazily, on the first ¹H/¹³C/¹⁹F prediction of
  // that nucleus) from the installed package. Nothing is downloaded; there is no network access.
  permissions: ["selection.read", "analysis.write", "ui.menu", "ui.panel", "model.load"],
  contributes: {
    commands: [
      {
        id: nmrPredictCarbonCommandId,
        title: "Predict ¹³C NMR Shifts",
        category: "Analyze",
        description:
          "Predict ¹³C shifts for the selected structure with the bundled GNN, cross-checked against HOSE-fragment lookup over NMRShiftDB2-derived statistics (the fallback where the GNN declines).",
        requiredPermissions: ["selection.read", "analysis.write"],
        enabled: true
      },
      {
        id: nmrPredictProtonCommandId,
        title: "Predict ¹H NMR Shifts (experimental)",
        category: "Analyze",
        description:
          "Experimental ¹H prediction with the bundled GNN, cross-checked against HOSE-fragment lookup (the fallback where the GNN declines); labile protons are omitted by default.",
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
      },
      {
        id: nmrPredictFluorineCommandId,
        title: "Predict ¹⁹F NMR Shifts (CF3 only)",
        category: "Analyze",
        description:
          "Predict the ¹⁹F shift of a CF3 group with the bundled NMRexp-trained GNN, cross-checked against HOSE-fragment lookup over NMRexp-derived statistics (the fallback where the GNN declines). CF3 only: molecules with more than one fluorine environment or another fluorine type get no ¹⁹F shift.",
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
      },
      {
        id: "menu.nmrPredictor.predictFluorine",
        title: "Predict ¹⁹F NMR Shifts (CF3 only)",
        commandId: nmrPredictFluorineCommandId,
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
