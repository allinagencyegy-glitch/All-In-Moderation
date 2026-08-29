/**
 * Arabic text normalisation for deterministic retrieval.
 *
 * Retrieval in this system is exact tag matching (ADR-010, open decision D1) — deliberately crude,
 * so that a miss surfaces as a visible knowledge gap rather than as a confidently wrong answer.
 * Crude matching only works if both sides of the comparison are spelled the same way, and Arabic
 * as typed by real people is not: the same word arrives as `أسنان` / `اسنان` / `أَسنان`, and
 * `الكرسي` and `كرسي` are the same noun with and without the definite article.
 *
 * Without this file the retriever appears to work — Arabic tokenises correctly through
 * `\p{L}` — and silently under-recalls. Silent under-recall is the worst available failure here,
 * because it degrades into "ask a human" rather than into a visible error, and so never gets
 * investigated.
 *
 * Both sides go through the same function. The tags on a knowledge entry are normalised when the
 * entry is imported, and a customer's message is normalised at retrieval time, so the two cannot
 * drift apart. Latin text passes through lowercased and otherwise untouched.
 */

/** Tatweel / kashida — a purely decorative elongation that carries no meaning. */
const TATWEEL = /ـ/gu;

/**
 * Harakat and Quranic annotation marks. Optional in ordinary writing, so their presence or
 * absence must never decide whether two words match.
 */
const DIACRITICS = /[ً-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/gu;

/** Zero-width joiners and marks that survive copy/paste and are invisible to the person typing. */
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

const ALEF = /[آأإٱٲٳٵ]/gu; // آ أ إ ٱ ٲ ٳ ٵ -> ا
const ALEF_MAKSURA = /ى/gu; // ى -> ي
const TA_MARBUTA = /ة/gu; // ة -> ه
const WAW_HAMZA = /[ؤٶ]/gu; // ؤ -> و
const YEH_HAMZA = /[ئٸېیي]/gu; // ئ ې ی ي -> ي (unify Farsi/Arabic yeh)
const LONE_HAMZA = /ء/gu; // ء -> dropped

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits. */
const ARABIC_INDIC = /[٠-٩]/gu;
const EXTENDED_ARABIC_INDIC = /[۰-۹]/gu;

const KEHEH = /ک/gu; // ک -> ك
const HEH_GOAL = /ہ/gu; // ہ -> ه

/**
 * Normalises one token or one span of text.
 *
 * Ordering matters: invisibles and diacritics are stripped before letter folding, so a hamza that
 * was carrying a fatha still folds. Digits are folded last because none of the letter rules touch
 * them.
 */
export function normalizeArabic(input: string): string {
  return input
    .replace(INVISIBLES, '')
    .replace(TATWEEL, '')
    .replace(DIACRITICS, '')
    .replace(ALEF, 'ا')
    .replace(YEH_HAMZA, 'ي')
    .replace(ALEF_MAKSURA, 'ي')
    .replace(TA_MARBUTA, 'ه')
    .replace(WAW_HAMZA, 'و')
    .replace(KEHEH, 'ك')
    .replace(HEH_GOAL, 'ه')
    .replace(LONE_HAMZA, '')
    .replace(ARABIC_INDIC, (d) => String(d.codePointAt(0)! - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.codePointAt(0)! - 0x06f0))
    .toLowerCase();
}

const DEFINITE_ARTICLE = 'ال'; // ال, after alef folding
const MIN_STEM_LENGTH = 3;

/**
 * Strips the definite article, but only when a usable stem remains.
 *
 * `الكرسي` -> `كرسي` is the whole point: a customer writes "الكرسي ده بكام" and the knowledge
 * entry is tagged `كرسي`. The length guard is what stops the rule mangling ordinary words that
 * merely begin with alef-lam — `الف` keeps its letters because the remainder is one character.
 *
 * Applied only to individual tokens, never to running text, so it cannot corrupt a stored body.
 */
export function stripDefiniteArticle(token: string): string {
  if (!token.startsWith(DEFINITE_ARTICLE)) return token;
  const stem = token.slice(DEFINITE_ARTICLE.length);
  return stem.length >= MIN_STEM_LENGTH ? stem : token;
}

/** Word boundaries: anything that is not a letter or a digit, in any script. */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** Below this a token carries no retrieval signal and costs a false match. */
export const MIN_TAG_LENGTH = 3;

/**
 * Turns free text into normalised retrieval tokens.
 *
 * Deduplicated and order-preserving. A token that is a definite-article form contributes *both*
 * spellings, because a knowledge entry may reasonably be tagged either way and neither is wrong.
 */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const raw of normalizeArabic(text).split(WORD_SPLIT)) {
    if (raw.length < MIN_TAG_LENGTH) continue;
    out.add(raw);
    const stem = stripDefiniteArticle(raw);
    if (stem !== raw && stem.length >= MIN_TAG_LENGTH) out.add(stem);
  }
  return [...out];
}

/**
 * Normalises an authored tag list.
 *
 * Used when a knowledge entry is imported, so that the tags stored on the row are in exactly the
 * shape `tokenize` produces from a customer's message. A multi-word tag (`كرسي أسنان`) is split
 * into its parts rather than kept whole, because the retriever compares single tokens.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    for (const token of tokenize(tag)) out.add(token);
  }
  return [...out];
}
