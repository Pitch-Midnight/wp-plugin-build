<?php
/**
 * PHP-side analyzer for trs-strip.js.
 *
 * Node cannot tokenize PHP correctly - trs-verify-build.js already learned
 * that the hard way (a regex over "asset paths" matched a commented-out
 * plugins_url() call). This script reuses that project's answer: shell out
 * to PHP's own token_get_all(), which understands comments, strings and
 * heredocs, and never confuses one for another.
 *
 * WHAT THIS FINDS, per file passed on argv
 * ---------------------------------------------------------------------------
 * 1. #[PM\Premium] attribute groups and the declaration each one attaches
 *    to (level 2 of 20-tier-build-split.md) - function/method, class/
 *    interface/trait/enum, class const, or property. The WHOLE span, from
 *    the attribute's own `#[` through the end of the declaration, is
 *    reported for deletion.
 * 2. `// <pm:premium>` ... `// </pm:premium>` comment-fence pairs (level 3)
 *    - any PHP comment form (line comment or block comment) containing
 *      the marker text. Because these are read from real
 *      T_COMMENT/T_DOC_COMMENT
 *      tokens, a marker-looking substring inside a STRING LITERAL can
 *      never be mistaken for a fence - the tokenizer already told us it is
 *      a string, not a comment.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 * It only FINDS spans and reports byte offsets. It never writes to the
 * file - trs-strip.js does the actual slicing, in Node, on its own copy of
 * the source, so this script can stay a pure read-only analysis pass.
 *
 * OUTPUT, one line per finding, tab-delimited, to stdout:
 *
 *   SPAN	<startByte>	<endByte>	<kind>	<line>	<symbol-or-empty>
 *   ERROR	<line>	<message>
 *
 * kind is one of: attribute, fence. symbol is the declared name for a
 * function/method/class (used for the dangling-reference check
 * downstream) or empty for anything else. Byte offsets are into the
 * ORIGINAL source, computed by summing token lengths in order - lossless,
 * because token_get_all() reconstructs the source exactly when its tokens
 * are concatenated back together.
 *
 * Output is grouped by a `FILE\t<path>` line preceding that file's own
 * SPAN/ERROR lines - a file with zero findings emits no lines at all, not
 * even its own FILE marker, so trs-strip.js never has to special-case an
 * empty group.
 *
 * KNOWN LIMITATION - array-style string interpolation inside a span
 * ---------------------------------------------------------------------------
 * `"$arr[key]"` inside a double-quoted string tokenizes its `[` and `]` as
 * REAL bracket tokens (PHP's "simple syntax" interpolation quirk), which
 * this script's brace/paren/bracket depth counter cannot distinguish from
 * a real array access. A function or class body containing this exact
 * shape could in principle be measured to the wrong closing brace. This is
 * accepted, not silently risked: trs-strip.js lints every resulting file
 * with `php -l` after stripping and REFUSES the build if any span
 * computation produced invalid PHP - the mechanical backstop for this and
 * any other span-boundary bug, not just this one case.
 *
 * NO ALIASING - `#[PM\Premium]` or `#[\PM\Premium]` must be spelled out in
 * full every time, even after a `use PM\Premium;` import that would let
 * PHP itself accept a bare `#[Premium]`. Resolving `use` aliases (plain,
 * grouped, `as`-renamed) correctly is a materially bigger parse than
 * finding attribute groups, and getting it wrong in either direction is
 * exactly the kind of ambiguity this design refuses to guess through. The
 * full form is more typing, not a real cost - see the design doc.
 *
 * SUPPORTED DECLARATION SHAPES after #[PM\Premium], DELIBERATELY NARROW
 * ---------------------------------------------------------------------------
 * function/method, class/interface/trait/enum, a single class const, or a
 * single property. Anything else - a parameter, an unrecognised shape, or
 * #[PM\Premium] stacked with ANY other attribute in the same group run -
 * is an ERROR, not a best-effort guess. See 20-tier-build-split.md's
 * "fail loudly" table: this script is the half of that table that runs
 * per-file, before the payload-wide leak/dangling checks in trs-strip.js.
 */

$MARKER_ATTR   = 'PM\\Premium';
$FENCE_OPEN    = '<pm:premium>';
$FENCE_CLOSE   = '</pm:premium>';

/**
 * Token text as PHP actually wrote it - token_get_all() gives array tokens
 * as [id, text, line] and single-character tokens as bare one-char
 * strings. Normalising here means every other function only deals with
 * ['id' => ..., 'text' => ..., 'line' => ...].
 */
function normalise_tokens( array $raw ): array {
	$out = array();
	foreach ( $raw as $t ) {
		if ( is_array( $t ) ) {
			$out[] = array( 'id' => $t[0], 'text' => $t[1], 'line' => $t[2] );
		} else {
			$out[] = array( 'id' => null, 'text' => $t, 'line' => null );
		}
	}
	return $out;
}

/**
 * Attach a byte offset (start, end-exclusive) to every token, by summing
 * token lengths in source order. Exact because token_get_all() is
 * lossless - concatenating every token's text reproduces the input.
 */
function with_offsets( array $tokens ): array {
	$pos = 0;
	foreach ( $tokens as &$t ) {
		$len         = strlen( $t['text'] );
		$t['start']  = $pos;
		$t['end']    = $pos + $len;
		$pos        += $len;
	}
	unset( $t );
	return $tokens;
}

/** Whitespace/comment tokens the declaration-shape scanner should skip over. */
function is_skippable( array $t ): bool {
	return in_array( $t['id'], array( T_WHITESPACE, T_COMMENT, T_DOC_COMMENT ), true );
}

/** True when the token is an open/close of one of ( [ { or their close. */
function depth_delta( array $t ): int {
	if ( $t['id'] === null ) {
		if ( in_array( $t['text'], array( '(', '[', '{' ), true ) ) {
			return 1;
		}
		if ( in_array( $t['text'], array( ')', ']', '}' ), true ) ) {
			return -1;
		}
	}
	if ( $t['id'] === T_CURLY_OPEN || $t['id'] === T_DOLLAR_OPEN_CURLY_BRACES ) {
		return 1;
	}
	return 0;
}

/**
 * Paren depth (counting ONLY `(` / `)`, not braces or brackets) BEFORE
 * each token index. Used to refuse an attribute that appears inside a
 * parameter list, a `new` expression's arg list, or any other
 * paren-enclosed context - the only legal PHP shape that puts one there
 * is a function/constructor PARAMETER, and this design does not support
 * deleting a parameter (it would have to remove it from every call site
 * too, an entirely different and out-of-scope kind of stripping). Without
 * this check, `find_declaration_end()`'s generic property/const branch
 * would match the parameter's `$var` and scan forward to the NEXT `;` it
 * finds - which is very likely inside the function BODY, silently
 * deleting the wrong span. Caught in testing before this was written.
 *
 * @return int[] Depth before token i, same length as $tokens.
 */
function compute_paren_depths( array $tokens ): array {
	$depths = array();
	$depth  = 0;
	foreach ( $tokens as $t ) {
		$depths[] = $depth;
		if ( $t['id'] === null && $t['text'] === '(' ) {
			$depth++;
		} elseif ( $t['id'] === null && $t['text'] === ')' ) {
			$depth = max( 0, $depth - 1 );
		}
	}
	return $depths;
}

/**
 * Find every #[ ... ] attribute group, return each as
 * [contentTokenIndexStart, contentTokenIndexEnd, groupStartTokenIdx, groupEndTokenIdx].
 * groupStart/End bound the WHOLE group including the #[ and matching ].
 */
function find_attribute_groups( array $tokens ): array {
	$groups = array();
	$n      = count( $tokens );

	for ( $i = 0; $i < $n; $i++ ) {
		if ( $tokens[ $i ]['id'] !== T_ATTRIBUTE ) {
			continue;
		}

		$depth = 1; // The #[ itself opens depth 1.
		$j     = $i + 1;
		for ( ; $j < $n; $j++ ) {
			$depth += depth_delta( $tokens[ $j ] );
			if ( $depth === 0 ) {
				break;
			}
		}

		if ( $depth !== 0 ) {
			// Unterminated attribute group - PHP itself would refuse to
			// parse this file, so token_get_all() already flagged it via
			// a T_BAD_CHARACTER or similar upstream. Nothing to report;
			// let PHP's own syntax error surface elsewhere in the pipeline.
			break;
		}

		$groups[] = array( 'start' => $i, 'end' => $j ); // end = index of matching ']'.
		$i        = $j;
	}

	return $groups;
}

/**
 * Does this attribute group contain PM\Premium, and ONLY PM\Premium (no
 * other attribute stacked in the same #[ ... ] group)? Returns
 * 'match' | 'other' | 'mixed', where 'mixed' means PM\Premium is present
 * but stacked with something else - an ERROR case the caller reports.
 */
function classify_group( array $tokens, array $group, string $marker ): string {
	$names = array();
	for ( $k = $group['start'] + 1; $k < $group['end']; $k++ ) {
		$t = $tokens[ $k ];
		if ( in_array( $t['id'], array( T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_STRING ), true ) ) {
			// A bare name could be a constructor-arg identifier, not the
			// attribute's own name - but only the FIRST such token at
			// depth 0 after a comma/group-start is actually an attribute
			// name. Depth tracking below keeps this to top-level names.
			$names[] = array( 'text' => ltrim( $t['text'], '\\' ), 'idx' => $k );
		}
	}

	// Re-walk at depth 0 to keep only names that open a top-level
	// attribute (i.e. not inside a constructor arg list).
	$depth      = 0;
	$topNames   = array();
	$expectName = true;
	for ( $k = $group['start'] + 1; $k < $group['end']; $k++ ) {
		$t = $tokens[ $k ];
		if ( is_skippable( $t ) ) {
			continue;
		}
		if ( $t['id'] === null && $t['text'] === ',' && $depth === 0 ) {
			$expectName = true;
			continue;
		}
		if ( $depth === 0 && $expectName
			&& in_array( $t['id'], array( T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_STRING ), true ) ) {
			$topNames[] = ltrim( $t['text'], '\\' );
			$expectName = false;
		}
		$depth += depth_delta( $t );
	}

	$hasMarker = in_array( $marker, $topNames, true );
	if ( ! $hasMarker ) {
		return 'other';
	}
	return count( $topNames ) === 1 ? 'match' : 'mixed';
}

/**
 * Is there ANOTHER attribute group immediately before this one - i.e.
 * `#[Deprecated] #[PM\Premium] public function y() {}` - with only
 * whitespace/comments between the two? Scanning forward alone (see
 * find_declaration_end()) catches a stacked group written AFTER
 * PM\Premium; a preceding group needs its own check, because deleting
 * only PM\Premium's own span in that case would leave `#[Deprecated]`
 * dangling with nothing after it - which is not free-tier PHP that fails
 * to strip cleanly, it is free-tier PHP that fails to PARSE.
 */
function has_preceding_attribute_group( array $tokens, int $groupStartIdx ): bool {
	$i = $groupStartIdx - 1;
	while ( $i >= 0 && is_skippable( $tokens[ $i ] ) ) {
		$i--;
	}
	// The token immediately before a `#[` group, once whitespace/comments
	// are skipped, is either the matching `]` of a PRECEDING attribute
	// group, or it is something else entirely (code, or nothing - start
	// of file). We cannot tell a bare `]` apart from an array-literal
	// close without walking back to its own opener.
	if ( $i < 0 || $tokens[ $i ]['id'] !== null || $tokens[ $i ]['text'] !== ']' ) {
		return false;
	}

	// depth_delta() does not know T_ATTRIBUTE ("#[") is an opener - only
	// find_attribute_groups()'s FORWARD scan seeds that specially. Walking
	// BACKWARD needs the same special-casing here: depth starts at 1 (for
	// the `]` already found above), and the token that brings it to 0 is
	// checked directly rather than through depth_delta, because that
	// token is exactly what tells us whether the `]` closed an attribute
	// group (T_ATTRIBUTE) or a plain array literal (a bare `[`).
	$depth = 1;
	$i--;
	for ( ; $i >= 0; $i-- ) {
		$t = $tokens[ $i ];
		if ( $t['id'] === T_ATTRIBUTE ) {
			$depth--;
			if ( $depth === 0 ) {
				return true;
			}
			continue;
		}
		if ( $t['id'] === null && $t['text'] === '[' ) {
			$depth--;
			if ( $depth === 0 ) {
				return false; // A plain array literal, not an attribute group.
			}
			continue;
		}
		if ( $t['id'] === null && $t['text'] === ']' ) {
			$depth++;
			continue;
		}
		$depth -= depth_delta( $t );
		if ( $depth === 0 ) {
			// Closed on a (){} pair rather than []/#[] - cannot happen
			// for a well-formed ']' match, but stop rather than loop
			// past it if it somehow does.
			return false;
		}
	}
	return false;
}

/**
 * From the end of a matched attribute group, scan forward past any
 * whitespace/comments to the declaration and find its end offset.
 * Returns ['end' => byte offset, 'symbol' => name or '', 'error' => msg|null].
 */
function find_declaration_end( array $tokens, int $afterIdx ): array {
	$n = count( $tokens );
	$i = $afterIdx;

	while ( $i < $n && is_skippable( $tokens[ $i ] ) ) {
		$i++;
	}

	if ( $i < $n && $tokens[ $i ]['id'] === T_ATTRIBUTE ) {
		return array(
			'end'    => null,
			'symbol' => '',
			'error'  => 'stacked attribute groups after #[PM\\Premium] are not supported - use exactly one attribute group',
		);
	}

	// Skip modifier keywords (public/private/protected/static/abstract/
	// final/readonly/var) - any number of them, in any order.
	$modifiers = array( T_PUBLIC, T_PRIVATE, T_PROTECTED, T_STATIC, T_ABSTRACT, T_FINAL, T_VAR );
	if ( defined( 'T_READONLY' ) ) {
		$modifiers[] = T_READONLY;
	}
	while ( $i < $n && ( is_skippable( $tokens[ $i ] ) || in_array( $tokens[ $i ]['id'], $modifiers, true ) ) ) {
		$i++;
	}

	if ( $i >= $n ) {
		return array( 'end' => null, 'symbol' => '', 'error' => 'file ended before a declaration followed #[PM\\Premium]' );
	}

	$kind = $tokens[ $i ]['id'];

	// -- function / method --------------------------------------------
	if ( $kind === T_FUNCTION ) {
		$j = $i + 1;
		while ( $j < $n && is_skippable( $tokens[ $j ] ) ) {
			$j++;
		}
		// Optional & (by-reference return, rare) then the name.
		if ( $j < $n && $tokens[ $j ]['id'] === null && $tokens[ $j ]['text'] === '&' ) {
			$j++;
			while ( $j < $n && is_skippable( $tokens[ $j ] ) ) {
				$j++;
			}
		}
		$symbol = ( $j < $n && $tokens[ $j ]['id'] === T_STRING ) ? $tokens[ $j ]['text'] : '';

		// Scan to the matching body '{' or a bare ';' (abstract/interface),
		// tracking depth so a default-value expression's own () or []
		// cannot be mistaken for the end.
		$depth = 0;
		for ( ; $j < $n; $j++ ) {
			$t = $tokens[ $j ];
			if ( $depth === 0 && $t['id'] === null && $t['text'] === ';' ) {
				return array( 'end' => $t['end'], 'symbol' => $symbol, 'error' => null );
			}
			if ( $depth === 0 && $t['id'] === null && $t['text'] === '{' ) {
				$braceDepth = 1;
				$j++;
				for ( ; $j < $n; $j++ ) {
					$braceDepth += depth_delta( $tokens[ $j ] );
					if ( $braceDepth === 0 ) {
						return array( 'end' => $tokens[ $j ]['end'], 'symbol' => $symbol, 'error' => null );
					}
				}
				return array( 'end' => null, 'symbol' => $symbol, 'error' => "unterminated function body for {$symbol}()" );
			}
			$depth += depth_delta( $t );
		}
		return array( 'end' => null, 'symbol' => $symbol, 'error' => "could not find the end of function {$symbol}()" );
	}

	// -- class / interface / trait / enum ------------------------------
	$classLike = array( T_CLASS, T_INTERFACE, T_TRAIT );
	if ( defined( 'T_ENUM' ) ) {
		$classLike[] = T_ENUM;
	}
	if ( in_array( $kind, $classLike, true ) ) {
		$j = $i + 1;
		while ( $j < $n && is_skippable( $tokens[ $j ] ) ) {
			$j++;
		}
		$symbol = ( $j < $n && $tokens[ $j ]['id'] === T_STRING ) ? $tokens[ $j ]['text'] : '';

		for ( ; $j < $n; $j++ ) {
			if ( $tokens[ $j ]['id'] === null && $tokens[ $j ]['text'] === '{' ) {
				$braceDepth = 1;
				$j++;
				for ( ; $j < $n; $j++ ) {
					$braceDepth += depth_delta( $tokens[ $j ] );
					if ( $braceDepth === 0 ) {
						return array( 'end' => $tokens[ $j ]['end'], 'symbol' => $symbol, 'error' => null );
					}
				}
				return array( 'end' => null, 'symbol' => $symbol, 'error' => "unterminated body for {$symbol}" );
			}
		}
		return array( 'end' => null, 'symbol' => $symbol, 'error' => "could not find the body of {$symbol}" );
	}

	// -- class const or property: scan to the first top-level ';' -----
	if ( $kind === T_CONST || $kind === T_VARIABLE || $kind === T_STRING || $kind === T_NAME_QUALIFIED
		|| $kind === T_NS_SEPARATOR || $kind === T_ARRAY || $kind === T_QUESTION_MARK ) {
		$symbol = '';
		if ( $kind === T_VARIABLE ) {
			$symbol = ltrim( $tokens[ $i ]['text'], '$' );
		}
		$depth = 0;
		for ( $j = $i; $j < $n; $j++ ) {
			$t = $tokens[ $j ];
			if ( $symbol === '' && $t['id'] === T_VARIABLE ) {
				$symbol = ltrim( $t['text'], '$' );
			}
			if ( $depth === 0 && $t['id'] === null && $t['text'] === ';' ) {
				return array( 'end' => $t['end'], 'symbol' => $symbol, 'error' => null );
			}
			$depth += depth_delta( $t );
		}
		return array( 'end' => null, 'symbol' => $symbol, 'error' => 'a property/const declaration after #[PM\\Premium] never reached a closing ;' );
	}

	return array(
		'end'    => null,
		'symbol' => '',
		'error'  => 'unsupported declaration shape after #[PM\\Premium] - only function/method, class/interface/trait/enum, a class const, or a property are supported',
	);
}

/** Find `<pm:premium>` / `</pm:premium>` pairs across all comment tokens. */
function find_fences( array $tokens, string $open, string $close ): array {
	$spans   = array();
	$pending = null; // ['start' => byte, 'line' => n]

	foreach ( $tokens as $t ) {
		if ( ! in_array( $t['id'], array( T_COMMENT, T_DOC_COMMENT ), true ) ) {
			continue;
		}

		$hasOpen  = strpos( $t['text'], $open ) !== false;
		$hasClose = strpos( $t['text'], $close ) !== false;

		if ( $hasOpen && $hasClose ) {
			$spans[] = array(
				'error' => "a single comment on line {$t['line']} contains both {$open} and {$close} - open and close must be separate comments",
			);
			continue;
		}

		if ( $hasOpen ) {
			if ( $pending !== null ) {
				$spans[] = array( 'error' => "nested {$open} on line {$t['line']} - the fence opened on line {$pending['line']} was never closed" );
				// Clear rather than keep the original pending open: the
				// FOLLOWING close, if any, must not pair up with it and
				// produce a spurious successful SPAN alongside this
				// error - it reports its own "no matching open" instead,
				// which is the more honest outcome (both problems named,
				// nothing silently half-recovered).
				$pending = null;
				continue;
			}
			$pending = array( 'start' => $t['start'], 'line' => $t['line'] );
			continue;
		}

		if ( $hasClose ) {
			if ( $pending === null ) {
				$spans[] = array( 'error' => "{$close} on line {$t['line']} has no matching {$open}" );
				continue;
			}
			$spans[]  = array( 'start' => $pending['start'], 'end' => $t['end'], 'line' => $pending['line'], 'error' => null );
			$pending  = null;
		}
	}

	if ( $pending !== null ) {
		$spans[] = array( 'error' => "{$open} on line {$pending['line']} was never closed" );
	}

	return $spans;
}

function emit_span( string $kind, int $start, int $end, int $line, string $symbol = '' ): void {
	echo "SPAN\t{$start}\t{$end}\t{$kind}\t{$line}\t{$symbol}\n";
}

function emit_error( int $line, string $message ): void {
	echo "ERROR\t{$line}\t{$message}\n";
}

// --------------------------------------------------------------------
// Main - one file per argv entry. Buffer each file's own lines so the
// FILE marker can precede them and a file with nothing to report emits
// no lines at all.
// --------------------------------------------------------------------
foreach ( array_slice( $argv, 1 ) as $file ) {
	$lines = array();
	$emit_span_local  = function ( $kind, $start, $end, $line, $symbol = '' ) use ( &$lines ) {
		$lines[] = "SPAN\t{$start}\t{$end}\t{$kind}\t{$line}\t{$symbol}";
	};
	$emit_error_local = function ( $line, $message ) use ( &$lines ) {
		$lines[] = "ERROR\t{$line}\t{$message}";
	};

	$src = file_get_contents( $file );
	if ( $src === false ) {
		$emit_error_local( 0, "could not read {$file}" );
		echo "FILE\t{$file}\n" . implode( "\n", $lines ) . "\n";
		continue;
	}

	$raw = @token_get_all( $src );
	if ( ! is_array( $raw ) ) {
		$emit_error_local( 0, "{$file} could not be tokenized (a PHP syntax error, most likely)" );
		echo "FILE\t{$file}\n" . implode( "\n", $lines ) . "\n";
		continue;
	}

	$tokens      = with_offsets( normalise_tokens( $raw ) );
	$parenDepths = compute_paren_depths( $tokens );

	foreach ( find_attribute_groups( $tokens ) as $group ) {
		$class = classify_group( $tokens, $group, $MARKER_ATTR );
		if ( $class === 'other' ) {
			continue;
		}
		if ( $parenDepths[ $group['start'] ] > 0 ) {
			$emit_error_local(
				$tokens[ $group['start'] ]['line'],
				'PM\\Premium appears inside parentheses (a function parameter, a `new` argument list, or similar) - stripping a parameter is not supported'
			);
			continue;
		}
		$line = $tokens[ $group['start'] ]['line'];
		if ( $class === 'mixed' ) {
			$emit_error_local( $line, 'PM\\Premium stacked with another attribute in the same #[ ... ] group is not supported - use PM\\Premium alone' );
			continue;
		}
		if ( has_preceding_attribute_group( $tokens, $group['start'] ) ) {
			$emit_error_local( $line, 'a separate #[ ... ] attribute group immediately precedes #[PM\\Premium] - stacking is not supported, because deleting only PM\\Premium\'s own declaration would leave the other attribute group dangling with nothing after it' );
			continue;
		}
		$decl = find_declaration_end( $tokens, $group['end'] + 1 );
		if ( $decl['error'] !== null ) {
			$emit_error_local( $line, $decl['error'] );
			continue;
		}
		$emit_span_local( 'attribute', $tokens[ $group['start'] ]['start'], $decl['end'], $line, $decl['symbol'] );
	}

	foreach ( find_fences( $tokens, $FENCE_OPEN, $FENCE_CLOSE ) as $span ) {
		if ( $span['error'] !== null ) {
			$emit_error_local( 0, $span['error'] );
			continue;
		}
		$emit_span_local( 'fence', $span['start'], $span['end'], $span['line'] );
	}

	if ( $lines ) {
		echo "FILE\t{$file}\n" . implode( "\n", $lines ) . "\n";
	}
}
