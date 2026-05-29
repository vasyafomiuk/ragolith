// Tiny wildcard matcher for file-path scoping. Mirrors Weaviate's `Like`
// semantics: `*` matches any run of characters, `?` matches one. Used to
// post-filter hybrid-search hits down to a path glob (the hybrid query itself
// can't always carry a Like filter through the search pipeline).

/** Convert a `*` / `?` wildcard pattern into an anchored RegExp. */
export function wildcardToRegExp(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True if `value` matches the wildcard `pattern`. */
export function matchesWildcard(pattern: string, value: string): boolean {
  return wildcardToRegExp(pattern).test(value);
}

/**
 * Normalize a user-supplied path scope into a wildcard pattern: bare
 * substrings get wrapped in `*…*`; patterns that already contain wildcards are
 * left as-is. Backslashes are normalized to forward slashes.
 */
export function toPathPattern(scope: string): string {
  const norm = scope.replace(/\\/g, '/');
  return norm.includes('*') || norm.includes('?') ? norm : `*${norm}*`;
}
