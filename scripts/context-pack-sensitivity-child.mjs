import {
  CONTEXT_PACK_ERROR_CODES,
  assembleContextPack,
} from "../src/ledger/context-pack.mjs";
import {
  CONTEXT_PACK_FIXTURE,
  buildContextPackFixture,
} from "./context-pack-fixture.mjs";

const label = process.env.E3_T04_SENSITIVITY_LABEL ?? "control";
const { input } = buildContextPackFixture({ maxMessages: 2 });
let expectedCode = null;

if (label === "source-head-binding") {
  input.sourceHeads = input.sourceHeads.map((head) =>
    head.stream === `channel:${CONTEXT_PACK_FIXTURE.channelId}`
      ? { ...head, digest: `sha256:${"0".repeat(64)}` }
      : head,
  );
  expectedCode = CONTEXT_PACK_ERROR_CODES.SOURCE_HEAD;
} else if (label === "private-scope-fence") {
  input.authorization.channel.kind = "private";
  expectedCode = CONTEXT_PACK_ERROR_CODES.PRIVATE_SCOPE;
} else if (label === "instruction-source-fence") {
  input.instructions[0].source = input.trigger.source;
  expectedCode = CONTEXT_PACK_ERROR_CODES.INSTRUCTION_SCOPE;
}

let error = null;
try {
  assembleContextPack(input);
} catch (candidate) {
  error = candidate;
}

if (label === "control") {
  if (error) process.exitCode = 1;
} else if (!error || error.code !== expectedCode) {
  process.exitCode = 1;
}
