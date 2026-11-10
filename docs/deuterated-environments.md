# Deuterated environment matching

The OCL provider treats deuterium as hydrogen when matching ¹H and ¹³C database
environments and checking rule-estimator applicability. This is a first-order
shift approximation: isotope shifts are ignored, as disclosed by
`NMR_DEUTERIUM_SHIFT_NOT_MODELLED`, which lists the D atom indices. It applies to
D on carbon and heteroatoms, including O and N. Molfile `D`, explicit `H` with
`M ISO` mass 2, and SMILES `[2H]` identify deuterium.

The original isotope-labelled graph still determines constitutional equivalence,
atom assignments and proton populations. D contributes no observed ¹H nucleus
and no H–H splitting partner. CH3, CHD2 and CD3 populations remain distinct even
when their hydrogen-matched shifts coincide. Removing D for shift matching does
not alter the caller's molecule. Unlabelled molecules follow the existing path.
Other isotope labels, including ¹³C, ¹⁵N and ³H, retain their unsupported-isotope
warning and rule-estimator refusal, including when mixed with D.

## Coupling and omitted splitting disclosures

Carbon–carbon vicinal H–D coupling is calculated and displayed as a typical
first-order estimate: the H–H class constant is scaled by 0.1535, with spin-1
patterns nested with H–H splitting and spacing set by the spectrometer field.
See [H–D implementation notes](deuterium-coupling.md) for the constants and rendering.

Geminal H–D and vicinal paths involving heteroatoms remain omitted. The warning
`NMR_DEUTERIUM_COUPLING_NOT_SHOWN` contains **H–D coupling not shown** and lists
the affected zero-based proton **host** atom indices, consistent with the shift
table's ¹H assignments. It covers displayed proton environments with D on the
same heavy atom (H–X–D, geminal) or an adjacent heavy atom where the proton host
or the deuterium-bearing atom is a heteroatom (H–X–Y–D, vicinal). Computed carbon–carbon vicinal paths do not trigger
this warning. This conservative graph check includes O/N hosts and does not depend
on exchange conditions. It does not cover longer-range paths, including aromatic meta paths.
It is emitted only for displayed ¹H environments in this range, so a ¹³C-only
request, an omitted OH environment, or D farther away does not trigger it.

For ¹³C requests, `NMR_CARBON_DEUTERIUM_SPLITTING_NOT_MODELLED` identifies carbon
atoms directly bearing D and states that C–D splitting and isotope shifts are
not modelled. Carbon shifts still use hydrogen-matched environments.

Existing first-order H–H patterns count ordinary hydrogen only. A singlet in a
deuterated environment can still have omitted geminal or heteroatom H–D structure;
the warning makes that limitation explicit. Deuterium caveats keep the analysis
status partial even when all shift environments have database matches, because
isotope shifts and C–D splitting remain unmodelled. Rule estimates also make the
status partial.

## Regression examples

The host-style V2000 regression cases use the median option for database matches,
with labile hydrogens enabled. Unmatched environments can use the rule-based
estimator; the rule estimates identified below are neither database values nor
experimental measurements:

- CH3CH2OD retains ethanol's CH3/CH2 ¹H shifts at 1.09/3.50 ppm (3H/2H) and
  ¹³C shifts at 13.93/65.00 ppm, with no OH resonance.
  The CH2 ¹H value of 3.50 ppm and ¹³C value of 65.00 ppm are rule-based estimates.
  The CH2 host carries the omitted H–D coupling warning; the CH3 host is outside
  the chosen range.
- CD3OH has no ¹H resonances. Its OH environment is declined with the same
  warning as plain methanol, which also has no supported OH match or fallback.
  Its carbon uses a rule-based estimate of 65.00 ppm and carries the C–D warning.
- C6D5H retains one aromatic ¹H at 7.36 ppm and all six carbons at 128.20 ppm. The proton has
  an estimated ortho H–D quintet (J = 1.1973 Hz; intensities 1:2:3:2:1), without
  the omitted-coupling warning for those computed paths. Longer-range H–D is omitted.
- CH3NHD keeps the hydrogen-matched methyl ¹H shift at 2.40 ppm (3H) and ¹³C
  shift at 32.20 ppm. The methyl ¹H value of 2.40 ppm is a rule-based estimate.
  It has only one N–H proton
  available as an H–H splitting partner. The unmatched NH environment is declined
  as for plain methylamine; the displayed methyl host carries the H–D warning.

`src/tests/deuteratedEnvironments.test.ts` also checks fallback estimates, mixed
isotope refusal, geminal/vicinal warning boundaries, reduced H–H partner counts,
and an unchanged complete ethanol result captured before this port.
