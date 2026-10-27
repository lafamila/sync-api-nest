import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomOpaque(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('base64url'); }
export function hmac256(secret: string, value: string): string { return createHmac('sha256', secret).update(value).digest('base64url'); }
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
export function decrypt(value: string, key: Buffer): string {
  const [iv, tag, body] = value.split('.');
  if (!iv || !tag || !body) throw new Error('Invalid encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
