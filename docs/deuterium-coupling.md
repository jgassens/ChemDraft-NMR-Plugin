# First-order proton coupling to deuterium

OpenChemLib parses both V2000 `D` and `H` with an `M ISO` mass of 2 as
atomic number 1, mass 2. Its total attached hydrogen count includes D.
`hydrogenIsotopes.ts` therefore subtracts explicit D when counting observed
protons or H–H partners. A fully deuterated host emits no ¹H resonance.
Isotope-aware constitutional classes remain separate, including CH₃ versus CHD₂.
The structure depiction labels mass-2 H atoms as D.

Vicinal carbon-bound D partners use the existing H–H class constant multiplied by
the single named `DEUTERIUM_PROTON_GYROMAGNETIC_RATIO` constant. Its adjacent code
comment cites Harris et al., IUPAC Recommendations 2001, *Pure Appl. Chem.*
73(11), 1795–1818, doi:10.1351/pac200173111795. Table 1 gives γ(¹H) and Table 2
gives γ(²H); their ratio is 0.153506, used to 4 figures as 0.1535. Verified
against the paper on 2026-11-10. Aliphatic vicinal
H–D is thus 1.0745 Hz. The same scaling uses the existing aromatic-ortho and
aldehyde constants where those classes apply. The H–H reporting cutoff is
unchanged; it does not suppress these smaller H–D estimates. There is no
geminal H–H constant in this code, so geminal H–D is omitted and disclosed.
Long-range H–D, ¹⁹F and ³¹P coupling are outside this change.

An optional `partnerNucleus: "2H"` distinguishes D groups in the serializable
coupling contract; an absent field retains the existing spin-½ H behavior.
H and D groups cannot merge. Labels use 2n+1 lines for n equivalent D.
`firstOrderLines()` convolves equal spin-1 states, giving 1:1:1, 1:2:3:2:1,
and 1:3:6:7:6:3:1 for one, two and three D, and nests them with H–H splitting.
Normalized line intensities sum to one, and coincident lines are combined.

For shifts only, a mapped copy folds D on every host, including O/N, to implicit H before
canonical lookup and rule estimates. The original molecule supplies all proton
counts, coupling topology, atom assignments and geometry. Shift tables and H–H
constants are unchanged. Thus CH₃CH₂OD retains the same CH₃ and CH₂ shifts as
ethanol, and C₆D₅H retains one benzene-like proton. Remaining O–H/N–H environments
use the same database coverage and fallback applicability as the unlabelled parent.
`NMR_DEUTERIUM_SHIFT_NOT_MODELLED` identifies
the explicit D atom indices and explains that D was treated as H for environment
matching and rule estimates, with isotope shifts ignored at first order. This
also applies to ¹³C-only requests. When ¹³C is requested, the additional
`NMR_CARBON_DEUTERIUM_SPLITTING_NOT_MODELLED` warning names zero-based carbon
indices carrying D: those carbon peaks are predicted, but C–D splitting and
isotope shifts are not modelled. No C–D coupling has been added.

Only mass-2 hydrogen receives this treatment. Other isotope labels, including
¹³C, ¹⁵N and ³H/T, retain the prior unsupported-isotope warning and rule refusal;
mixed D/other-isotope inputs still disclose the unsupported labels. No tritium
couplings are introduced. The original carbon-bound H–D topology rules are
unchanged: O–D/N–D, geminal and long-range H–D couplings remain unmodelled.
`NMR_DEUTERIUM_COUPLING_NOT_SHOWN` identifies displayed proton hosts with omitted
geminal or heteroatom vicinal paths; computed carbon–carbon vicinal paths do not
trigger it. Isotope-shift and C–D caveats still make the analysis status partial,
even when every shift has a database match. Rule estimates also remain partial.

The vendored panel SDK strictly accepts only `jHz` and `partnerCount` per
coupling; its renderer assumes spin ½. The host keeps its selected spectrometer
field in the renderer and does not pass it into the prediction command or report
composer. H-only multiplets already carry Hz couplings and are field-aware.

For a resonance with D coupling, the plugin calculates the complete symmetric
H/H–D pattern in Hz, then represents each ±offset pair as a centered doublet
with `jHz = 2 × abs(offsetHz)` and `partnerCount = 1`. A zero-offset line is a
centered singlet. These are display components, not additional physical H–H
couplings: the table and stored prediction retain the original physical J values.
The host positions each doublet at `centerPpm ± jHz / (2 × observeMHz)` using
the actual selected field. Since its two doublet lines both have relative height
one, each component retains the original per-line intensity times the predicted
proton count, rather than summing the two partners. This reproduces all spin-1
intensities and nested H–H splitting without applying either pattern twice.
Atom links, confidence, estimate styling and alternative shift centers ride along
on every component; comparison lines retune by the same Hz offsets.

Rendered figure exports use the host's selected field. The standalone
`renderStickSpectrumSvg` helper accepts `protonFrequencyMHz` (default 400 MHz),
calculates ppm positions at that field, and states it in the SVG legend. Stored
shifts remain at the predicted resonance centers. Resonances without D coupling
keep their existing rendering and serialized shapes, including default SVG bytes.

Host limitation: `spectrumToJcampDx` currently exports input peak centers only;
it neither expands nor serializes `couplings`. As with existing H-only multiplets,
its JCAMP peak table therefore does not preserve the rendered splitting. For H/D
patterns it contains centered display components, not resolved multiplet lines.
Use rendered SVG/PNG/PDF exports to retain the field-adjusted pattern. Supporting
resolved JCAMP multiplets requires a host change outside this plugin repository.

`src/tests/deuterium.test.ts` covers both molfile encodings, ethanol-1,1-d₂,
CH₃–CHD₂, CHD₂ counts, D-only hosts, spin-1 intensities, nested splitting,
schema preservation, SDK-valid panel output, and the carbon isotope warning.
`src/tests/deuteratedEnvironments.test.ts` adds ChemDraft-style explicit H +
`M ISO` mass-2 molfile regressions for CH₃CH₂OD, CD₃OH and C₆D₅H, checks parent
environment codes and fallback applicability, and exercises missing-database
fallback for O–D. Normalization tests distinguish D from unsupported labels.
Field regression cases reconstruct the host's binomial rendering contract at
400, 600 and 800 MHz and require physical H–D and H–H spacing within 1e-9 Hz,
unchanged line intensities, and matching alternative shifts. Standalone SVG
checks verify the serialized geometry at each field and reject invalid fields.
`src/tests/fixtures/noDeuteriumOutput.json` contains SHA-256 digests captured
before implementation for complete serialized results, reports and SVGs from
ten existing ordinary structures. Those comparisons require byte-for-byte
unchanged output, including shift values, H–H constants and property ordering.

## Environment-matching regression measurements

With the bundled database, median shifts and labile protons enabled:

| Structure | ¹H centers (ppm, integration) | ¹³C centers (ppm) |
| --- | --- | --- |
| CH₃CH₂OD | 1.09 (3H), 3.50 (2H) | 13.93, 65.00 |
| CD₃OH | OH unavailable (see below); no methyl protons | 65.00 |
| C₆D₅H | 7.36 (1H), estimated ortho H–D quintet, J = 1.1973 Hz | 128.20 for all six carbons |

The bundled database has no methanol O–H match (`Oq0h1(1Ch3)`), and the current
proton fallback requires a carbon host. Consequently both ordinary CH₃OH and
CD₃OH omit OH with the same unmatched-OH coverage warning, even when labile
protons are requested. The passing CD₃OH regression confirms that its deuterated
methyl contributes no ¹H resonances and that the unmatched OH is declined, never
fabricated. Supplying an OH resonance requires additional defensible database
coverage or a disclosed labile-proton fallback; applying that fallback equally
to H and D also changes unlabelled methanol behavior. This change preserves the
existing unlabelled behavior and does not invent a methanol OH value.

## Field-aware follow-up validation

Single-file runs passed before the full suite: `deuterium.test.ts` (33 tests),
`stickSpectrumSvg.test.ts` (14), `composePredictionReport.test.ts` (17), and
`coupling.test.ts` (10). The no-D SHA-256 baselines remain unchanged.

A read-only smoke check also evaluated the actual desktop `multipletLines`
function from `LinkedFigureView.tsx` against the new reports. All 120 rendered
lines across 400, 600 and 800 MHz matched expected Hz offsets within 1e-9 Hz
and intensities within 1e-14, including aliphatic, aldehyde, aromatic and nested
H/H–D patterns. No host files were changed.

The full `npm test` suite was run once with the writable task `TMPDIR`:
305 tests passed in 25 files; the two release-package suites skipped because no
release archive was built. The long-chain timing check passed (2.70 seconds).
A strict TypeScript check of the three changed report modules also passed.

## Original H–D implementation validation

Single-file checks passed before the full run:

- `vitest run src/tests/deuterium.test.ts`: 27 passed, including ten byte-for-byte
  no-D regression cases.
- `vitest run src/tests/coupling.test.ts`: 10 passed.
- `vitest run src/tests/composePredictionReport.test.ts`: 17 passed.
- `vitest run src/tests/stickSpectrumSvg.test.ts`: 7 passed.
- `vitest run src/tests/oclHosePredictor.test.ts`: 88 passed; its long-chain
  measurement was 2.60 seconds.

The full `npm test` suite was run once, with `TMPDIR` set to the task's writable
temporary directory: 291 passed and one failed. The only failure was the existing
long-chain timing bound (17.75 seconds versus 7.5 seconds). The requested isolated
rerun, `vitest run src/tests/oclHosePredictor.test.ts -t 'keeps 13C-only long-chain'`,
also exceeded the bound at 11.44 seconds. No timing assertion was changed. The
package integration and package asset suites skipped because no release archive
was built in this worktree.

An ad-hoc strict TypeScript check passed for the changed domain, topology, lookup,
depiction and report modules. Including `OclHosePredictor.ts` exposes the existing
optional-array narrowing error inside the stereo-disclosure callback. The same
error was reproduced against the original file from `HEAD` (original line 165;
current line 179), so it was left outside this coupling change. The initial
non-strict ad-hoc invocation also lacked Node test typings and did not support the
existing discriminated-union checks; it is not a configured repository check.

Release review still needs an assessment of the variable long-chain timing
result. Geminal and
long-range H–D coupling, isotope-dependent shifts, and native spin-1 host
metadata remain outside this implementation. Dependencies were
reused through the instructed temporary `node_modules` symlink; no installation
or dependency changes were made, and the symlink was removed after validation.
