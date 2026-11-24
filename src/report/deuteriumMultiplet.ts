import type { NmrResonance } from "../domain/contracts";
import { firstOrderLines } from "../domain/firstOrderCoupling";

/** Default for standalone SVGs only. Interactive spectra use the host's selected field. */
export const DEFAULT_PROTON_FREQUENCY_MHZ = 400;

export function hasDeuteriumCoupling(resonance: NmrResonance): boolean {
  return resonance.multiplet?.couplings.some((coupling) => coupling.partnerNucleus === "2H") ?? false;
}

export function deuteriumMultipletLines(resonance: NmrResonance) {
  return hasDeuteriumCoupling(resonance)
    ? firstOrderLines(resonance.multiplet!.couplings)
    : undefined;
}

/**
 * The SDK can render only spin-½ coupling groups, and does not pass its selected field to plugins.
 * Represent the symmetric H/D pattern as centered doublets plus an optional central singlet.
 * A doublet's separation is twice the absolute line offset, in Hz. The host divides by its actual
 * observation frequency at render time. Its doublet heights are both 1, so retaining the per-line
 * intensity preserves every rendered height (do not sum the two partners' intensities).
 * These separations are display components, not additional physical H–H couplings.
 */
export function deuteriumMultipletComponents(resonance: NmrResonance) {
  return deuteriumMultipletLines(resonance)
    ?.filter((line) => line.offsetHz <= 0)
    .map((line) => ({ separationHz: -2 * line.offsetHz, intensity: line.intensity }));
}
