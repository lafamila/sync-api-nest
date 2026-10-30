import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dockerfile = readFileSync(resolve(__dirname, '../Dockerfile'), 'utf8');
const installs = dockerfile.split('\n').filter((line) => /^RUN npm ci(?:\s|$)/.test(line));

describe('Docker dependency download policy', () => {
  it('retries transient registry failures for backend build dependencies', () => {
    expect(installs[0]).toMatch(/^RUN npm ci --fetch-retries=5$/);
  });

  it('retries transient registry failures for web build dependencies', () => {
    expect(installs[1]).toMatch(/^RUN npm ci --prefix web --fetch-retries=5$/);
  });

  it('keeps runtime installs locked and propagates installation failures', () => {
    expect(installs).toHaveLength(3);
    expect(installs[2]).toMatch(/^RUN npm ci --omit=dev --fetch-retries=5 && npm cache clean --force$/);
  });

  it('does not bypass TLS or switch to an unencrypted registry', () => {
    expect(dockerfile).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|strict-ssl\s*[= ]\s*false|--registry[= ]http:/);
    expect(dockerfile).not.toMatch(/\bnpm install\b|\|\|\s*(?:true|:)(?:\s|$)/);
  });
});
