// Portable WebCrypto envelope. Published files never contain the password/key.
export const PRIVATE_FORMAT_VERSION = 1;
export const PRIVATE_MAX_BYTES = 12 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const ITERATIONS = 600000;
const DOMAIN = 'agent-learning-atlas/private-library/v1';
export const PRIVATE_UNLOCK_ERROR = '无法解锁：密码不正确或加密内容已损坏。';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
const fail = () => { throw new Error(PRIVATE_UNLOCK_ERROR); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const text = (value, max=10000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value);
const idArray = value => Array.isArray(value) && value.length <= 300 && value.every(identifier) && new Set(value).size === value.length;
function encode64(bytes) {
  let binary = '';
  for (let i=0; i<bytes.length; i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function decode64(value, expected) {
  if (typeof value !== 'string' || value.length > PRIVATE_MAX_BYTES * 4 / 3 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) fail();
  const binary = atob(value.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-value.length%4)%4));
  const bytes = Uint8Array.from(binary,c=>c.charCodeAt(0));
  if ((expected !== undefined && bytes.length !== expected) || encode64(bytes) !== value) fail();
  return bytes;
}
export function validateEnvelope(envelope) {
  try {
    if (!exactKeys(envelope,['version','kdf','cipher','ciphertext']) || envelope.version !== PRIVATE_FORMAT_VERSION) fail();
    const {kdf,cipher} = envelope;
    if (!exactKeys(kdf,['name','hash','iterations','salt']) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || kdf.iterations !== ITERATIONS) fail();
    if (!exactKeys(cipher,['name','iv','tagLength','aad']) || cipher.name !== 'AES-GCM' || cipher.tagLength !== 128 || cipher.aad !== DOMAIN) fail();
    if (JSON.stringify(envelope).length > PRIVATE_MAX_BYTES) fail();
    decode64(kdf.salt,16); decode64(cipher.iv,12);
    if (decode64(envelope.ciphertext).length < 17) fail();
    return envelope;
  } catch { fail(); }
}
export function validatePrivatePayload(payload) {
  if (!exactKeys(payload,['version','lessons','sources']) || payload.version !== PRIVATE_FORMAT_VERSION || !Array.isArray(payload.lessons) || payload.lessons.length !== 5 || !Array.isArray(payload.sources) || payload.sources.length > 500) fail();
  if (encoder.encode(JSON.stringify(payload)).length > MAX_PLAINTEXT_BYTES) fail();
  const lessons = new Set(), sources = new Set();
  for (const source of payload.sources) {
    if (!object(source) || !identifier(source.id) || sources.has(source.id) || !text(source.title) || !text(source.url,8192)) fail();
    let url; try { url = new URL(source.url); } catch { fail(); }
    if (url.protocol !== 'https:' || url.username || url.password) fail();
    sources.add(source.id);
  }
  const usedSources = new Set();
  for (const lesson of payload.lessons) {
    if (!object(lesson) || !identifier(lesson.id) || lessons.has(lesson.id) || lesson.internal !== true || !text(lesson.title) || !identifier(lesson.stage) || !text(lesson.summary) || !text(lesson.markdown,1024*1024) || !idArray(lesson.sourceIds) || !lesson.sourceIds.length || !idArray(lesson.prerequisites)) fail();
    for (const id of lesson.sourceIds) { if (!sources.has(id)) fail(); usedSources.add(id); }
    lessons.add(lesson.id);
  }
  if (sources.size !== usedSources.size) fail();
  return payload;
}
async function derive(password, salt, cryptoApi, usage) {
  if (!text(password,1024) || !cryptoApi?.subtle) fail();
  const bytes = encoder.encode(password);
  try {
    const base = await cryptoApi.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveKey']);
    return await cryptoApi.subtle.deriveKey({name:'PBKDF2',salt,iterations:ITERATIONS,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,[usage]);
  } finally { bytes.fill(0); }
}
export async function encryptPrivatePayload(payload,password,cryptoApi=globalThis.crypto) {
  validatePrivatePayload(payload);
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  let key = await derive(password,salt,cryptoApi,'encrypt');
  const plaintext = encoder.encode(JSON.stringify(payload));
  try {
    const ciphertext = new Uint8Array(await cryptoApi.subtle.encrypt({name:'AES-GCM',iv,tagLength:128,additionalData:encoder.encode(DOMAIN)},key,plaintext));
    return validateEnvelope({version:1,kdf:{name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:encode64(salt)},cipher:{name:'AES-GCM',iv:encode64(iv),tagLength:128,aad:DOMAIN},ciphertext:encode64(ciphertext)});
  } finally { plaintext.fill(0); key = null; }
}
export async function decryptPrivatePayload(envelope,password,cryptoApi=globalThis.crypto) {
  let plaintext, key;
  try {
    validateEnvelope(envelope);
    key = await derive(password,decode64(envelope.kdf.salt,16),cryptoApi,'decrypt');
    plaintext = new Uint8Array(await cryptoApi.subtle.decrypt({name:'AES-GCM',iv:decode64(envelope.cipher.iv,12),tagLength:128,additionalData:encoder.encode(DOMAIN)},key,decode64(envelope.ciphertext)));
    if (plaintext.length > MAX_PLAINTEXT_BYTES) fail();
    return validatePrivatePayload(JSON.parse(decoder.decode(plaintext)));
  } catch { fail(); }
  finally { plaintext?.fill(0); key = null; }
}
