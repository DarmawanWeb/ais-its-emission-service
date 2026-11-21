import type { Principal } from '@darmawanweb/ais-its-nest/auth';

import { SuperAdminRequiredError } from './errors.js';

/** `true` for a user with the platform role `super_admin`. */
export function isPlatformAdmin(principal: Principal): boolean {
  return principal.kind === 'user' && principal.isPlatformAdmin;
}

/** Throws `403 SUPER_ADMIN_REQUIRED` unless the principal is a platform administrator. */
export function assertPlatformAdmin(principal: Principal): void {
  if (!isPlatformAdmin(principal)) throw new SuperAdminRequiredError();
}

/** Organizations a principal may read records of: all (platform admins) or the active one. */
export type OrgScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'org'; readonly orgId: string | null };

/** The {@link OrgScope} of a principal (spec §8.5 tenancy). */
export function orgScopeOf(principal: Principal): OrgScope {
  return isPlatformAdmin(principal)
    ? { kind: 'all' }
    : { kind: 'org', orgId: principal.orgId };
}
