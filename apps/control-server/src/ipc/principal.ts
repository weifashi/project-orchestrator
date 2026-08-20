import { createHash, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';

export type AuthenticatedInstallation = Readonly<{
  installationId: string;
  clientType: 'codex' | 'claude';
}>;
export type CredentialAuthenticator = (credential: string) => AuthenticatedInstallation;

export const secureEqual = (leftValue: string, rightValue: string): boolean => {
  const left = createHash('sha256').update(leftValue).digest();
  const right = createHash('sha256').update(rightValue).digest();
  return timingSafeEqual(left, right);
};

const matchesHash = (credential: string, expectedHash: string): boolean => {
  const actual = createHash('sha256').update(credential).digest();
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export function createCredentialAuthenticator(
  db: Database.Database,
  expectedCredential?: string,
): CredentialAuthenticator {
  return (credential) => {
    if (expectedCredential !== undefined && !secureEqual(credential, expectedCredential)) {
      throw new Error('UNAUTHENTICATED');
    }
    const matches = (db.prepare("SELECT id,client_type,credential_hash FROM client_installations WHERE status='active'")
      .all() as Array<{ id: string; client_type: 'codex' | 'claude'; credential_hash: string }>)
      .filter((row) => matchesHash(credential, row.credential_hash));
    if (matches.length !== 1) throw new Error('UNAUTHENTICATED');
    const installation = matches[0] as typeof matches[number];
    db.prepare('UPDATE client_installations SET last_seen_at=? WHERE id=?')
      .run(new Date().toISOString(), installation.id);
    return Object.freeze({
      installationId: installation.id, clientType: installation.client_type,
    });
  };
}
