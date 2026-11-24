const SUPERSCRIPT_DIGITS: Readonly<Record<string, string>> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹"
};

/** Display form of a nucleus token with a superscript mass number ("31P" → "³¹P"). For user-visible text only; never for codes or machine fields. */
export function nucleusLabel(nucleus: string): string {
  return nucleus.replace(/^\d+/, (digits) => [...digits].map((digit) => SUPERSCRIPT_DIGITS[digit] ?? digit).join(""));
}
