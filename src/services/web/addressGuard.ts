/**
 * Address guard for the web tools.
 *
 * `web_fetch` takes a URL straight from the model, so without a guard a prompt
 * injection ("fetch http://169.254.169.254/latest/meta-data/") turns the
 * extension into a proxy into the user's own machine, LAN, or cloud metadata
 * service. This module answers one question: may we send an HTTP request to
 * this URL?
 *
 * Scope for v1: hostname and literal-IP checks only. We deliberately do NOT
 * resolve DNS and pin the resulting address, so a hostile domain whose A record
 * points at 127.0.0.1 still gets through. That is a known, accepted gap: the
 * realistic threat here is a model that was talked into typing an internal
 * address, not an attacker who also controls a domain. DNS pinning needs a
 * custom agent/dispatcher and belongs in a later pass.
 */

/** Host suffixes that always mean "not the public internet". */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".home.arpa"]

/** Exact hostnames that always mean the local machine. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"])

/**
 * Parses a dotted-quad IPv4 literal. Returns the four octets, or `undefined`
 * when the string is not an IPv4 literal at all (a normal hostname).
 */
function parseIPv4(hostname: string): number[] | undefined {
	const parts = hostname.split(".")

	if (parts.length !== 4) {
		return undefined
	}

	const octets: number[] = []

	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) {
			return undefined
		}
		const value = Number(part)
		if (value > 255) {
			return undefined
		}
		octets.push(value)
	}

	return octets
}

/**
 * Classifies an IPv4 literal. Returns the human-readable reason it is blocked,
 * or `undefined` when the address is a normal public one.
 */
function blockedIPv4Reason(octets: number[]): string | undefined {
	const [a, b] = octets

	if (a === 127) {
		return "127.0.0.0/8 is the loopback range on this machine"
	}
	if (a === 0) {
		return "0.0.0.0/8 is not a routable destination"
	}
	if (a === 10) {
		return "10.0.0.0/8 is a private network range"
	}
	if (a === 172 && b >= 16 && b <= 31) {
		return "172.16.0.0/12 is a private network range"
	}
	if (a === 192 && b === 168) {
		return "192.168.0.0/16 is a private network range"
	}
	if (a === 169 && b === 254) {
		return "169.254.0.0/16 is the link-local range, which includes the cloud metadata service"
	}
	if (a === 100 && b >= 64 && b <= 127) {
		return "100.64.0.0/10 is carrier-grade NAT space, not the public internet"
	}
	if (a >= 224) {
		return "addresses at or above 224.0.0.0 are multicast or reserved"
	}

	return undefined
}

/**
 * Expands an IPv6 literal into its eight 16-bit groups.
 *
 * Handles the `::` shorthand and a trailing dotted-quad ("::ffff:127.0.0.1").
 * Returns `undefined` when the string is not a usable IPv6 literal, which the
 * caller treats as "block it", since an address we cannot classify is not an
 * address we should send a request to.
 */
function expandIPv6(address: string): number[] | undefined {
	// Strip a zone index ("fe80::1%eth0") before parsing.
	let bare = address.split("%")[0]

	if (!bare) {
		return undefined
	}

	// A trailing dotted-quad becomes the last two groups. The WHATWG URL parser
	// already rewrites these into hex, but a caller may hand us the raw form.
	const dotted = bare.match(/:((?:\d{1,3}\.){3}\d{1,3})$/)
	if (dotted) {
		const octets = parseIPv4(dotted[1])
		if (!octets) {
			return undefined
		}
		const high = ((octets[0] << 8) | octets[1]).toString(16)
		const low = ((octets[2] << 8) | octets[3]).toString(16)
		bare = `${bare.slice(0, dotted.index)}:${high}:${low}`
	}

	const [head, tail, ...extra] = bare.split("::")

	if (extra.length > 0) {
		return undefined
	}

	const toGroups = (part: string): number[] | undefined => {
		if (!part) {
			return []
		}
		const groups: number[] = []
		for (const chunk of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/.test(chunk)) {
				return undefined
			}
			groups.push(parseInt(chunk, 16))
		}
		return groups
	}

	const headGroups = toGroups(head)
	const tailGroups = tail === undefined ? [] : toGroups(tail)

	if (!headGroups || !tailGroups) {
		return undefined
	}

	if (tail === undefined) {
		// No "::" shorthand: the literal must already be complete.
		return headGroups.length === 8 ? headGroups : undefined
	}

	const missing = 8 - headGroups.length - tailGroups.length

	if (missing < 0) {
		return undefined
	}

	return [...headGroups, ...new Array(missing).fill(0), ...tailGroups]
}

/**
 * Classifies an IPv6 literal, given WITHOUT the surrounding brackets and
 * already lowercased. Returns the reason it is blocked, or `undefined`.
 */
function blockedIPv6Reason(address: string): string | undefined {
	const groups = expandIPv6(address)

	if (!groups) {
		return `"${address}" is not an address web_fetch can verify as public`
	}

	const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1
	if (isLoopback) {
		return "::1 is the IPv6 loopback address"
	}

	if (groups.every((group) => group === 0)) {
		return ":: is not a routable destination"
	}

	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms would
	// sneak a blocked v4 address past the v6 rules, so decode and re-check.
	const leadingZeros = groups.slice(0, 5).every((group) => group === 0)
	const isV4Embedded = leadingZeros && (groups[5] === 0xffff || groups[5] === 0)

	if (isV4Embedded) {
		const octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
		const reason = blockedIPv4Reason(octets)
		if (reason) {
			return reason
		}
	}

	const first = groups[0]

	// fc00::/7 (unique local) covers the fc and fd prefixes.
	if ((first & 0xfe00) === 0xfc00) {
		return "fc00::/7 is the IPv6 unique-local range"
	}

	// fe80::/10 (link-local).
	if ((first & 0xffc0) === 0xfe80) {
		return "fe80::/10 is the IPv6 link-local range"
	}

	// ff00::/8 (multicast).
	if ((first & 0xff00) === 0xff00) {
		return "ff00::/8 is the IPv6 multicast range"
	}

	return undefined
}

/**
 * Checks whether a URL points at a public internet address.
 *
 * @returns `undefined` when the target is allowed, otherwise a short reason
 * phrase (no leading capital, no trailing period) that the caller embeds in a
 * tool-error sentence.
 */
export function assertPublicHttpUrl(url: URL): string | undefined {
	// `URL.hostname` keeps IPv6 literals in brackets and lowercases everything.
	const hostname = url.hostname.toLowerCase()

	if (!hostname) {
		return "it has no hostname"
	}

	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		return blockedIPv6Reason(hostname.slice(1, -1))
	}

	if (BLOCKED_HOSTNAMES.has(hostname)) {
		return `"${hostname}" is this machine`
	}

	for (const suffix of BLOCKED_HOST_SUFFIXES) {
		if (hostname.endsWith(suffix)) {
			return `"${suffix}" hostnames are local or internal network names`
		}
	}

	const octets = parseIPv4(hostname)
	if (octets) {
		return blockedIPv4Reason(octets)
	}

	// A bare IPv6 literal can still show up when a caller hands us a hostname
	// rather than a parsed URL; treat anything with a colon as one.
	if (hostname.includes(":")) {
		return blockedIPv6Reason(hostname)
	}

	return undefined
}
