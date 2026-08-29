import { readFile } from "node:fs/promises";
import {
  createConnectionStore,
  normalizeMetadata,
} from "@stream-slack/connections";

const AjvModule =
  await import("/opt/homebrew/lib/node_modules/verdaccio/node_modules/ajv/dist/2020.js");
const Ajv = AjvModule.default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
const schema = JSON.parse(
  await readFile(
    "packages/connections/src/schemas/connection-events.v1.schema.json",
    "utf8",
  ),
);
const validate = ajv.compile(schema);

const scope = {
  tenantId: "tenant-critic-a23ffed",
  workspaceId: "workspace-critic-a23ffed",
};
const admin = {
  ...scope,
  id: "user-critic-a23ffed-admin",
  kind: "user",
  role: "admin",
};
const secretRef = {
  schemaVersion: 1,
  id: "secretref-critic-a23ffed-001",
  provider: "infisical",
  mount: "production",
  revision: 1,
  label: "broker",
};

function event(metadata = {}) {
  return {
    schemaVersion: 1,
    eventId: "event-critic-a23ffed-created",
    eventType: "connection.created",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "idempotency-critic-a23ffed-created",
    sequence: 1,
    serverTimestamp: "2026-08-20T18:00:00.000Z",
    connectionId: "connection-critic-a23ffed",
    data: {
      connectionId: "connection-critic-a23ffed",
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      owner: { kind: "workspace", id: scope.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Audit label",
      metadata,
      secretRef,
      revision: 1,
    },
  };
}

function rejected(action) {
  try {
    action();
    return { accepted: true, code: null, path: null };
  } catch (error) {
    return {
      accepted: false,
      code: error?.code ?? "UNKNOWN",
      path: error?.path ?? null,
    };
  }
}

function storeResult(value) {
  const store = createConnectionStore({
    ...scope,
    clock: () => new Date("2026-08-20T18:00:00.000Z"),
    idFactory: (kind) => kind + "-critic-a23ffed",
  });
  const result = rejected(() =>
    store.create({
      actor: admin,
      connectionId: "connection-critic-a23ffed",
      owner: { kind: "workspace", id: scope.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Audit label",
      metadata: { candidate: value },
      secretRef,
      idempotencyKey: "create-critic-a23ffed",
    }),
  );
  return { ...result, appended: store.events().length };
}

const cases = [
  ["percent-json-encoded-braces", "%7B%22token%22%3A%22redacted%22%7D"],
  [
    "double-percent-json-encoded-braces",
    "%257B%2522token%2522%253A%2522redacted%2522%257D",
  ],
  ["mixed-percent-json-all-delimiters", "%7B%22%74oken%22%3A%22redacted%22%7D"],
  [
    "double-mixed-json-key-and-delimiters",
    "%7B%2522%2563lient%255Fsecre%2574%2522%253A%2522redacted%2522%257D",
  ],
  ["double-mixed-assignment", "cl%2569ent-%2573ecre%2574%253Dredacted"],
  [
    "double-mixed-prefixed-assignment",
    "prefix-%2563lient%255Fsecre%2574%253Dredacted",
  ],
  [
    "double-mixed-url",
    "%2568%2574tps%253A%252F%252Fexample.invalid%252Fservice",
  ],
  ["double-mixed-provider", "%2567%2568p%255F" + "A".repeat(16)],
  [
    "percent-private-key",
    "%2D%2D%2D%2D%2DBEGIN%20PRIVATE%20KEY%2D%2D%2D%2D%2D",
  ],
  ["ordinary-percent-text", "release%2F2026%20notes"],
];

const results = cases.map(([name, value]) => {
  const metadata = { candidate: value };
  return {
    name,
    runtime: rejected(() => normalizeMetadata(metadata)),
    store: storeResult(value),
    publicSchema: {
      accepted: validate(event(metadata)),
      errors: validate.errors ?? [],
    },
  };
});

console.log(
  JSON.stringify(
    {
      task: "E5-T02",
      critic: "a23ffed-independent",
      cases: results,
      findings: results.filter(
        (result) =>
          result.name !== "ordinary-percent-text" &&
          !result.runtime.accepted &&
          result.store.appended === 0 &&
          result.publicSchema.accepted,
      ),
      positiveControl: results.find(
        (result) => result.name === "ordinary-percent-text",
      ),
    },
    null,
    2,
  ),
);
