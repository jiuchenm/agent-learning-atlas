import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const api = () => import('../src/private-crypto.js');
const fixture = () => ({version:1, lessons:Array.from({length:5}, (_, i) => ({
  id:'synthetic-'+i, title:'Synthetic lesson '+i, internal:true, stage:'sample',
  summary:'Synthetic summary', prerequisites:[], sourceIds:['synthetic-source'],
  markdown:'# Synthetic lesson '+i+'\n\nPrivate synthetic content '+i+'.',
})), sources:[{id:'synthetic-source', title:'Synthetic reference', url:'https://example.test/reference'}]});
const password = 'Synthetic-test-password-with-adequate-length-12345';
test('encrypted payload roundtrips through WebCrypto without exposing content', async () => {
  const {encryptPrivatePayload, decryptPrivatePayload} = await api();
  const payload = fixture();
  const envelope = await encryptPrivatePayload(payload, password, webcrypto);
  assert.deepEqual(await decryptPrivatePayload(envelope, password, webcrypto), payload);
  for (const secret of [password, 'Synthetic lesson', 'Private synthetic content', 'example.test']) assert.ok(!JSON.stringify(envelope).includes(secret));
  assert.equal(envelope.kdf.iterations, 600000);
  assert.equal(envelope.cipher.name, 'AES-GCM');
});
test('wrong password and corruption fail with the same generic error', async () => {
  const {encryptPrivatePayload, decryptPrivatePayload} = await api();
  const envelope = await encryptPrivatePayload(fixture(), password, webcrypto);
  const corrupt = structuredClone(envelope);
  corrupt.ciphertext = (corrupt.ciphertext[0] === 'A' ? 'B' : 'A') + corrupt.ciphertext.slice(1);
  let message;
  for (const [value, secret] of [[envelope,'wrong-password'], [corrupt,password]]) await assert.rejects(decryptPrivatePayload(value, secret, webcrypto), error => {
    message ??= error.message; assert.equal(error.message,message); assert.doesNotMatch(error.message,/OperationError|Synthetic|password=/); return true;
  });
});
test('repeated encryption uses fresh salt and nonce', async () => {
  const {encryptPrivatePayload} = await api();
  const a = await encryptPrivatePayload(fixture(),password,webcrypto), b = await encryptPrivatePayload(fixture(),password,webcrypto);
  assert.notEqual(a.kdf.salt,b.kdf.salt); assert.notEqual(a.cipher.iv,b.cipher.iv); assert.notEqual(a.ciphertext,b.ciphertext);
});
test('envelope rejects unsupported parameters, malformed encoding and excessive data', async () => {
  const {encryptPrivatePayload, validateEnvelope} = await api();
  const good = await encryptPrivatePayload(fixture(),password,webcrypto);
  for (const change of [{version:2},{extra:'unexpected'},{ciphertext:'!'},{ciphertext:'A'.repeat(30000000)},
    {kdf:{...good.kdf,iterations:1}}, {kdf:{...good.kdf,iterations:600000000}}, {kdf:{...good.kdf,hash:'SHA-1'}}, {kdf:{...good.kdf,salt:'AA'}},
    {cipher:{...good.cipher,iv:'AA'}}, {cipher:{...good.cipher,name:'AES-CBC'}}, {cipher:{...good.cipher,tagLength:32}}, {cipher:{...good.cipher,aad:'different-domain'}}]) assert.throws(() => validateEnvelope({...good,...change}));
});
test('payload requires five distinct private lessons and a closed source dictionary', async () => {
  const {validatePrivatePayload} = await api();
  assert.deepEqual(validatePrivatePayload(fixture()),fixture());
  for (const mutate of [p=>p.lessons.pop(),p=>p.lessons.push(p.lessons[0]),p=>p.lessons[1].id=p.lessons[0].id,p=>p.lessons[0].internal=false,
    p=>p.sources=[],p=>p.sources[0].url='javascript:alert(1)',p=>p.lessons[0].markdown='',p=>p.lessons[0].sourceIds=['missing']]) {
    const p=fixture(); mutate(p); assert.throws(()=>validatePrivatePayload(p));
  }
});
