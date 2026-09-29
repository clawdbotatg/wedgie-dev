export type RepoApp = {
  mod: string; name: string; about: string; files: string[]; paths: string[];
  entry?: string; usb?: boolean; chip?: string; fw?: string; label: string; icon: string[];
};
export const MAX_APPS: number;
export const MAX_FILES: number;
export const MAX_APP_BYTES: number;
export const CHIPS: string[];
export const DEFAULT_ICON: string[];
export function checkAppJson(j: unknown, core?: string[], taken?: string[]): { apps: RepoApp[]; errors: string[] };
export function parseRepo(s: string): { owner: string; repo: string; ref?: string } | null;
export function cmpVersion(a: string, b: string): number;
