import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_TAG_LENGTH,
  normalizeArabic,
  normalizeTags,
  stripDefiniteArticle,
  tokenize,
} from '../../src/platform/text/normalize-arabic.ts';

/**
 * Retrieval is exact tag matching, so normalisation *is* recall.
 *
 * Every case below came from the same place: the two spellings a real customer and a real
 * knowledge author produce for the same word. A failure here does not look like a bug — it looks
 * like the assistant politely saying it will check with a colleague, forever.
 */
describe('arabic normalisation', () => {
  it('folds the alef family, which is the single biggest source of missed matches', () => {
    for (const written of ['أسنان', 'إسنان', 'اسنان', 'آسنان', 'ٱسنان']) {
      assert.equal(normalizeArabic(written), 'اسنان', `${written} must fold to اسنان`);
    }
  });

  it('strips diacritics and tatweel, which carry no retrieval signal', () => {
    assert.equal(normalizeArabic('أَسْنَان'), 'اسنان');
    assert.equal(normalizeArabic('اســنان'), 'اسنان');
  });

  it('removes invisibles that survive copy and paste', () => {
    // A zero-width joiner between two letters is invisible to the person who typed it and fatal
    // to an exact match.
    assert.equal(normalizeArabic('اس‍نان'), 'اسنان');
    assert.equal(normalizeArabic('﻿كرسي'), 'كرسي');
  });

  it('unifies the yeh, ta marbuta, waw hamza and Farsi letter forms', () => {
    assert.equal(normalizeArabic('كرسى'), 'كرسي');
    assert.equal(normalizeArabic('صيانة'), 'صيانه');
    assert.equal(normalizeArabic('مسؤول'), 'مسوول');
    assert.equal(normalizeArabic('کرسی'), 'كرسي');
  });

  it('converts both Arabic-Indic digit ranges to ASCII', () => {
    assert.equal(normalizeArabic('٠١٢٣٤٥٦٧٨٩'), '0123456789');
    assert.equal(normalizeArabic('۰۱۲۳'), '0123');
    assert.equal(normalizeArabic('٠١١١١٧٧٢٨٦٥'), '01111772865');
  });

  it('lowercases Latin and otherwise leaves it alone', () => {
    assert.equal(normalizeArabic('Roson R2 Pro'), 'roson r2 pro');
  });

  it('is idempotent, so importing twice cannot change a stored tag', () => {
    const once = normalizeArabic('أَسْنَان ٢٠٢٦');
    assert.equal(normalizeArabic(once), once);
  });

  describe('the definite article', () => {
    it('is stripped when a usable stem remains', () => {
      assert.equal(stripDefiniteArticle('الكرسي'), 'كرسي');
    });

    it('is kept when stripping it would leave a fragment', () => {
      // `الف` is a word, not "the ف". The guard is what stops the rule mangling ordinary text.
      assert.equal(stripDefiniteArticle('الف'), 'الف');
    });

    it('leaves a token that never had one untouched', () => {
      assert.equal(stripDefiniteArticle('كرسي'), 'كرسي');
    });
  });

  describe('tokenize', () => {
    it('emits both spellings, so either authoring choice matches', () => {
      const tokens = tokenize('الكرسي ده بكام؟');
      assert.ok(tokens.includes('الكرسي'));
      assert.ok(tokens.includes('كرسي'));
    });

    it('drops tokens too short to carry signal', () => {
      for (const token of tokenize('هل ده كرسي')) {
        assert.ok(token.length >= MIN_TAG_LENGTH, `${token} is below the floor`);
      }
    });

    it('splits on punctuation and emoji without losing the words around them', () => {
      assert.deepEqual(tokenize('سعر—الكرسي؟🙂'), ['سعر', 'الكرسي', 'كرسي']);
    });

    it('deduplicates and preserves first-seen order', () => {
      assert.deepEqual(tokenize('كرسي كرسي صيانة'), ['كرسي', 'صيانه']);
    });

    it('returns nothing for text with no usable token', () => {
      assert.deepEqual(tokenize('؟؟ 🙂 ..'), []);
    });

    it('matches a customer spelling against an author spelling of the same word', () => {
      // The load-bearing property: both sides of the comparison go through this function, so
      // `أسنان` typed by a customer reaches an entry an author tagged `اسنان`.
      const authored = new Set(normalizeTags(['كرسي أسنان']));
      assert.ok(tokenize('عايز أَسنان كرسي جديد').some((token) => authored.has(token)));
    });
  });

  describe('normalizeTags', () => {
    it('splits a multi-word tag into the tokens the retriever compares', () => {
      assert.deepEqual(normalizeTags(['كرسي أسنان']), ['كرسي', 'اسنان']);
    });

    it('produces exactly what tokenize produces from the same text', () => {
      const text = 'الكرسي والجهاز';
      assert.deepEqual(normalizeTags([text]), tokenize(text));
    });

    it('deduplicates across tags', () => {
      assert.deepEqual(normalizeTags(['كرسي', 'الكرسي', 'كرسى']), ['كرسي', 'الكرسي']);
    });
  });
});
