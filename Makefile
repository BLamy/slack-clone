.PHONY: verify-E0 verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E1 verify-E1-T01 verify-E1-T02 verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 verify-E1-T08 projection-E1-T07-rebuild projection-E1-T07-catch-up projection-E1-T07-corruption projection-E1-T07-shadow

verify-E0: verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07

verify-E0-T01:
	@node tools/verify-e0-t01.mjs

verify-E0-T02:
	@node scripts/cold-verify-e0-t02.mjs

verify-E0-T03:
	@node scripts/cold-verify-e0-t03.mjs

verify-E0-T04:
	@node scripts/cold-verify-e0-t04.mjs

verify-E0-T05:
	@node scripts/cold-verify-e0-t05.mjs

verify-E0-T06:
	@node scripts/cold-verify-e0-t06.mjs

verify-E0-T07:
	@node scripts/cold-verify-e0-t07.mjs

verify-E1-T01:
	@node scripts/cold-verify-e1-t01.mjs

verify-E1-T02:
	@node scripts/cold-verify-e1-t02.mjs

verify-E1-T03:
	@node scripts/cold-verify-e1-t03.mjs

verify-E1-T04:
	@node scripts/cold-verify-e1-t04.mjs

verify-E1-T05:
	@node scripts/cold-verify-e1-t05.mjs

verify-E1-T06:
	@node scripts/cold-verify-e1-t06.mjs

verify-E1-T07:
	@node scripts/cold-verify-e1-t07.mjs

verify-E1-T08:
	@node scripts/cold-verify-e1-t08.mjs

verify-E1:
	@node scripts/composed-verify-e1.mjs

projection-E1-T07-rebuild:
	@node scripts/e1-t07-command.mjs rebuild

projection-E1-T07-catch-up:
	@node scripts/e1-t07-command.mjs catch-up

projection-E1-T07-corruption:
	@node scripts/e1-t07-command.mjs corruption

projection-E1-T07-shadow:
	@node scripts/e1-t07-command.mjs shadow
