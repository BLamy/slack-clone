export function materializeMessages(records) {
  const messages = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.id !== "string")
      continue;
    messages.set(record.id, record);
  }
  return [...messages.values()];
}
