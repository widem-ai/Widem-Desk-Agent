// The measure for Arabic reply quality: Latin-letter words in an Arabic reply, apart from an allowed list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latinWords } from '../src/latin.mjs';

test('allowed Latin in an Arabic reply: LinkedIn, CV, SAR, booking references, email addresses', () => {
  assert.deepEqual(latinWords('السعر 1450 SAR للسيرة CV وملف LinkedIn. رقم الحجز **BK-0001**، البريد test@example.com'), []);
});

test('any other Latin word is flagged, once each, in order', () => {
  assert.deepEqual(latinWords('الفئة senior ومكالمة kickoff، cv_rewrite و senior مرة أخرى'), ['senior', 'kickoff', 'cv_rewrite']);
  assert.deepEqual(latinWords('تمت إضافة express'), ['express']);
});

test('an English reply is not measured', () => {
  assert.deepEqual(latinWords('Your senior kickoff call is booked.'), []);
});
