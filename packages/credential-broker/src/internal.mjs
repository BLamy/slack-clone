export const CREDENTIAL_BROKER_ADAPTER = Symbol("credential-broker-adapter");

const trustedAdapters = new WeakSet();

export function registerTrustedAdapter(adapter) {
  trustedAdapters.add(adapter);
  return adapter;
}

export function isTrustedAdapter(adapter) {
  return trustedAdapters.has(adapter);
}
