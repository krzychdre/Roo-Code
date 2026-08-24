// npx vitest run services/web/__tests__/addressGuard.spec.ts

import { assertPublicHttpUrl } from "../addressGuard"

/** Returns the block reason for a URL string, or undefined when allowed. */
const check = (url: string) => assertPublicHttpUrl(new URL(url))

describe("assertPublicHttpUrl", () => {
	describe("allows normal public targets", () => {
		it.each([
			"https://example.com/page",
			"http://docs.python.org/3/library/json.html",
			"https://zod.dev",
			"https://8.8.8.8/",
			"https://1.1.1.1/help",
			"https://172.15.0.1/",
			"https://172.32.0.1/",
			"https://192.167.0.1/",
			"https://searx.example.org/search?q=x",
			"https://sub.domain.example.co.uk/a/b",
		])("%s", (url) => {
			expect(check(url)).toBeUndefined()
		})
	})

	describe("blocks the local machine", () => {
		it.each([
			["http://localhost:8080/", /this machine/],
			["http://LOCALHOST/", /this machine/],
			["http://app.localhost/", /local or internal network names/],
			["http://127.0.0.1/", /loopback/],
			["http://127.1.2.3/", /loopback/],
			["http://[::1]/", /IPv6 loopback/],
			["http://0.0.0.0/", /not a routable destination/],
		])("%s", (url, pattern) => {
			expect(check(url)).toMatch(pattern)
		})
	})

	describe("blocks private and link-local ranges", () => {
		it.each([
			["http://10.0.0.1/", /private network range/],
			["http://10.255.255.254/admin", /private network range/],
			["http://172.16.0.1/", /private network range/],
			["http://172.31.255.254/", /private network range/],
			["http://192.168.1.1/", /private network range/],
			["http://100.64.0.1/", /carrier-grade NAT/],
			["http://[fc00::1]/", /unique-local/],
			["http://[fd12:3456::1]/", /unique-local/],
			["http://[fe80::1]/", /link-local/],
		])("%s", (url, pattern) => {
			expect(check(url)).toMatch(pattern)
		})
	})

	describe("blocks cloud metadata", () => {
		it("blocks the AWS/GCP/Azure metadata address", () => {
			expect(check("http://169.254.169.254/latest/meta-data/")).toMatch(/link-local range.*cloud metadata/)
		})

		it("blocks the whole link-local range", () => {
			expect(check("http://169.254.1.2/")).toMatch(/link-local/)
		})
	})

	describe("blocks internal hostname suffixes", () => {
		it.each([
			"http://metadata.internal/",
			"http://build.intranet/",
			"http://printer.local/",
			"http://router.home.arpa/",
		])("%s", (url) => {
			expect(check(url)).toMatch(/local or internal network names/)
		})
	})

	describe("blocks IPv4 addresses smuggled inside IPv6 literals", () => {
		it.each([
			["http://[::ffff:127.0.0.1]/", /loopback/],
			["http://[::ffff:169.254.169.254]/", /link-local/],
			["http://[::ffff:10.0.0.1]/", /private network range/],
		])("%s", (url, pattern) => {
			expect(check(url)).toMatch(pattern)
		})
	})

	it("blocks multicast and reserved space", () => {
		expect(check("http://224.0.0.1/")).toMatch(/multicast or reserved/)
		expect(check("http://255.255.255.255/")).toMatch(/multicast or reserved/)
		expect(check("http://[ff02::1]/")).toMatch(/multicast/)
	})

	it("is case-insensitive about hostnames", () => {
		expect(check("http://METADATA.INTERNAL/")).toMatch(/local or internal network names/)
	})

	it("does not mistake a hostname that merely contains digits for an IP", () => {
		expect(check("https://192-168-1-1.example.com/")).toBeUndefined()
		expect(check("https://1.2.3.4.example.com/")).toBeUndefined()
	})
})
