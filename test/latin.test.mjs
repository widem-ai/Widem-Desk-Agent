// The measure for Arabic reply quality: Latin-letter words in an Arabic reply, apart from an allowed list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latinWords, arabicWords } from '../src/latin.mjs';

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

test('known Latin slips in an Arabic reply become Arabic; anything without a safe mapping stays and is still flagged', () => {
  assert.equal(arabicWords('احجز مكالمة kickoff الآن، رقم referencia هو BK-0001'), 'احجز مكالمة البداية الآن، رقم المرجع هو BK-0001');
  assert.equal(arabicWords('موعد الـ Kickoff call يوم الثلاثاء'), 'موعد الـ مكالمة البداية يوم الثلاثاء');
  assert.equal(arabicWords('خدمة cv_rewrite مع express'), 'خدمة إعادة كتابة السيرة الذاتية مع تسليم سريع');
  const left = arabicWords('الفئة senior والحجز reference BK-0002');
  assert.equal(left, 'الفئة senior والحجز المرجع BK-0002');
  assert.deepEqual(latinWords(left), ['senior']);
});

test('an English reply keeps its words', () => {
  assert.equal(arabicWords('Your kickoff call reference is BK-0001.'), 'Your kickoff call reference is BK-0001.');
});
