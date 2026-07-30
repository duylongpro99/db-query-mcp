/**
 * assertSingleStatement — reject `;`-separated multi-statement SQL before it
 * reaches the engine. A single trailing `;` is allowed; a `;` followed by more
 * SQL is rejected. Semicolons inside string literals ('...'), escape strings
 * (E'...'), quoted identifiers ("..."), line comments (-- ), block comments
 * (slash-star) and dollar-quoted bodies ($tag$...$tag$) are ignored.
 *
 * This is a CONSERVATIVE guard (it may reject exotic-but-valid input) and it is
 * DEFENCE IN DEPTH ONLY. The structural defense is the extended wire protocol
 * (see PostgresDriver.exec), under which the SERVER rejects multi-statement text
 * outright — this scanner just fails such input earlier, with a 400, before any
 * DB contact. Never let it become the only thing standing between a read-only
 * token and a smuggled `COMMIT`.
 *
 * Assumes `standard_conforming_strings = on` (the Postgres default since 9.1):
 * a backslash is literal inside '...' and only escapes inside E'...'.
 */

// Postgres dollar-quote tag: empty ($$) or an identifier that can't start with a digit.
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/;

/** Identifier char — used to tell an `E'…'` prefix from the tail of a word. */
function isIdentChar(c: string | undefined): boolean {
    return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

/** Advance past a run of whitespace and SQL comments starting at `i`. */
function skipBlank(sql: string, i: number): number {
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i++;
        } else if (c === '-' && sql[i + 1] === '-') {
            i += 2;
            while (i < n && sql[i] !== '\n') i++;
        } else if (c === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            i += 2;
        } else {
            break;
        }
    }
    return i;
}

export function assertSingleStatement(sql: string): void {
    const n = sql.length;
    let i = 0;
    while (i < n) {
        const c = sql[i];

        // Skip comments so a `;` inside them is ignored.
        if (c === '-' && sql[i + 1] === '-') {
            i += 2;
            while (i < n && sql[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        // Skip single-quoted string literals (with '' escape).
        if (c === "'") {
            // An E-prefixed string processes backslash escapes, so `\'` does NOT
            // terminate it. Missing that made the scanner believe the string was
            // still open and swallow every following `;` — e.g.
            // `SELECT E'\''; COMMIT; …` smuggled a COMMIT past the guard and out of
            // the read-only transaction. The `E` must stand alone: in `value'x'` the
            // trailing `e` belongs to the identifier, not to the literal.
            const escapeString = (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdentChar(sql[i - 2]);
            i++;
            while (i < n) {
                if (escapeString && sql[i] === '\\') { i += 2; continue; }
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") { i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        // Skip double-quoted identifiers (with "" escape).
        if (c === '"') {
            i++;
            while (i < n) {
                if (sql[i] === '"') {
                    if (sql[i + 1] === '"') { i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        // Skip dollar-quoted bodies ($tag$ ... $tag$).
        if (c === '$') {
            const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
            if (tag) {
                const end = sql.indexOf(tag, i + tag.length);
                i = end === -1 ? n : end + tag.length;
                continue;
            }
        }
        // A top-level `;`: allowed only if nothing but blank/comments follows.
        if (c === ';') {
            if (skipBlank(sql, i + 1) < n) {
                throw new Error('Multiple SQL statements are not allowed (one statement per request).');
            }
            return;
        }
        i++;
    }
}
