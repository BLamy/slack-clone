.PHONY: verify-E0-T01 verify-E0-T02 verify-E0-T03

verify-E0-T01:
	@node tools/verify-e0-t01.mjs

verify-E0-T02:
	@node scripts/cold-verify-e0-t02.mjs

verify-E0-T03:
	@node scripts/cold-verify-e0-t03.mjs
