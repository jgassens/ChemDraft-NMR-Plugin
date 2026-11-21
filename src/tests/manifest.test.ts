import { parsePluginManifest, validatePluginManifest } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it } from "vitest";

import {
  nmrPredictCarbonCommandId,
  nmrPredictPhosphorusCommandId,
  nmrPredictProtonCommandId,
  nmrPredictorManifest,
  nmrPredictorPanelId
} from "../manifest";

describe("nmrPredictorManifest", () => {
  it("requires the ChemDraft 1.2 host API", () => {
    expect(nmrPredictorManifest.apiVersion).toBe("^0.1.25");
  });

  it("is a valid plugin manifest", () => {
    expect(nmrPredictorManifest).not.toHaveProperty("dataLicenses");
    expect(validatePluginManifest(nmrPredictorManifest).ok).toBe(true);
    const parsed = parsePluginManifest(nmrPredictorManifest);
    expect(parsed.id).toBe("org.chemdraft.nmr.predictor");
    expect(parsed.contributes.commands.map((command) => command.id)).toEqual([
      nmrPredictCarbonCommandId,
      nmrPredictProtonCommandId,
      nmrPredictPhosphorusCommandId
    ]);
    expect(parsed.contributes.menus).toHaveLength(3);
    expect(parsed.contributes.analyzers).toHaveLength(1);
    expect(parsed.contributes.panels[0]?.id).toBe(nmrPredictorPanelId);
  });

  it("declares model.load for the bundled GNN and no download or network permission", () => {
    expect(nmrPredictorManifest.permissions).toEqual(["selection.read", "analysis.write", "ui.menu", "ui.panel", "model.load"]);
    const parsed = parsePluginManifest(nmrPredictorManifest);
    expect(parsed.permissions).toContain("model.load");
    for (const permission of ["model.download", "network.fetch", "ml.inference", "filesystem.read"]) {
      expect(parsed.permissions).not.toContain(permission);
    }
    // Commands keep their existing requirements, so the HOSE fallback never depends on the model.
    for (const command of parsed.contributes.commands) {
      expect(command.requiredPermissions).not.toContain("model.load");
    }
  });

  it("registers through the real host, with all contribution command references resolvable", () => {
    const host = new PluginHost();
    // assertContributionCommands (M2) rejects menu/panel/analyzer entries referencing a
    // non-contributed command; a clean registration proves the manifest is internally consistent.
    expect(() =>
      host.registerPlugin(nmrPredictorManifest, {
        commandHandlers: {
          [nmrPredictCarbonCommandId]: async () => undefined,
          [nmrPredictProtonCommandId]: async () => undefined,
          [nmrPredictPhosphorusCommandId]: async () => undefined
        }
      })
    ).not.toThrow();

    expect(host.listMenuContributions("analyze").map((entry) => entry.contribution.commandId)).toEqual([
      nmrPredictCarbonCommandId,
      nmrPredictProtonCommandId,
      nmrPredictPhosphorusCommandId
    ]);
  });
});
