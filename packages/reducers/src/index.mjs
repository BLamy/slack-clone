export function materializeMessages(records) {
  const messages = new Map();
  for (const record of records) {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.id !== "string"
    ) {
      if (record?.dispatch?.operation === "chat.room.reset") messages.clear();
      continue;
    }
    if (record.dispatch !== undefined) {
      const projected = { ...record };
      delete projected.dispatch;
      messages.set(record.id, projected);
    } else {
      messages.set(record.id, record);
    }
  }
  return [...messages.values()];
}
