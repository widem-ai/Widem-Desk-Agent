// The model is a server setting (DESK_MODEL), so the server can move off a model NVIDIA deprecates without a code
// change. Unset or blank keeps DEFAULT_MODEL; a set value is the model named in the request to Token Factory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNebiusModel, modelFromEnv, DEFAULT_MODEL } from '../src/chat.mjs';

test('modelFromEnv: unset or blank keeps the default model', () => {
  assert.equal(DEFAULT_MODEL, 'nvidia/nemotron-3-super-120b-a12b');
  for (const env of [{}, { DESK_MODEL: '' }, { DESK_MODEL: '   ' }]) assert.equal(modelFromEnv(env), DEFAULT_MODEL);
});

test('modelFromEnv: a set value is used, trimmed', () => {
  assert.equal(modelFromEnv({ DESK_MODEL: ' nvidia/Nemotron-3_5-Lightning ' }), 'nvidia/Nemotron-3_5-Lightning');
});

const capture = () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
  };
  return { bodies, fetchImpl };
};

async function modelSentWith(deskModel) {
  const saved = process.env.DESK_MODEL;
  if (deskModel === undefined) delete process.env.DESK_MODEL; else process.env.DESK_MODEL = deskModel;
  try {
    const { bodies, fetchImpl } = capture();
    const model = createNebiusModel({ baseUrl: 'http://model.invalid/v1', apiKey: 'test', fetchImpl });
    await model.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    return bodies[0].model;
  } finally {
    if (saved === undefined) delete process.env.DESK_MODEL; else process.env.DESK_MODEL = saved;
  }
}

test('DESK_MODEL in the env is the model named in the request body', async () => {
  assert.equal(await modelSentWith('nvidia/Nemotron-3.5-Super-VL'), 'nvidia/Nemotron-3.5-Super-VL');
});

test('DESK_MODEL unset or blank: the request names the default model', async () => {
  assert.equal(await modelSentWith(undefined), DEFAULT_MODEL);
  assert.equal(await modelSentWith('  '), DEFAULT_MODEL);
});
