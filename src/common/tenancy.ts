import type { Principal } from '@darmawanweb/ais-its-nest/auth';

/**
 * `true` for a user with the platform role `super_admin`. Routes reserved
 * to platform administrators use the kit's `@RequirePlatformAdmin()`
 * (`403 PLATFORM_ADMIN_REQUIRED`); this only widens the read scope.
 */
export function isPlatformAdmin(principal: Principal): boolean {
  return principal.kind === 'user' && principal.isPlatformAdmin;
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
