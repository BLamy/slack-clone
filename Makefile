.PHONY: verify-E0 verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E1 verify-E1-T01 verify-E1-T02 verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 verify-E1-T08 verify-E2 verify-E2-T01 verify-E2-T02 verify-E2-T03 verify-E2-T04 verify-E2-T05 verify-E2-T06 verify-E2-T07 verify-E2-T08 verify-E3-T01 verify-E3-T02 verify-E3-T03 verify-E3-T04 projection-E1-T07-rebuild projection-E1-T07-catch-up projection-E1-T07-corruption projection-E1-T07-shadow

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

verify-E2-T01:
	@node scripts/cold-verify-e2-t01.mjs

verify-E2-T02:
	@node scripts/cold-verify-e2-t02.mjs

verify-E2-T03:
	@node scripts/cold-verify-e2-t03.mjs

verify-E2-T04:
	@node scripts/cold-verify-e2-t04.mjs

verify-E2-T05:
	@E2_T05_ENTRYPOINT='make verify-E2-T05' node scripts/cold-verify-e2-t05.mjs

verify-E2-T06:
	@E2_T06_ENTRYPOINT='make verify-E2-T06' node scripts/cold-verify-e2-t06.mjs

verify-E2-T07:
	@E2_T07_ENTRYPOINT='make verify-E2-T07' node scripts/cold-verify-e2-t07.mjs

verify-E2-T08:
	@E2_T08_ENTRYPOINT='make verify-E2-T08' node scripts/cold-verify-e2-t08.mjs

verify-E3-T01:
	@E3_T01_ENTRYPOINT='make verify-E3-T01' node scripts/cold-verify-e3-t01.mjs

verify-E3-T02:
	@E3_T02_ENTRYPOINT='make verify-E3-T02' node scripts/cold-verify-e3-t02.mjs

verify-E3-T03:
	@E3_T03_ENTRYPOINT='make verify-E3-T03' node scripts/cold-verify-e3-t03.mjs

verify-E3-T04:
	@E3_T04_ENTRYPOINT='make verify-E3-T04' node scripts/cold-verify-e3-t04.mjs

verify-E2:
	@node scripts/composed-verify-e2.mjs

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
