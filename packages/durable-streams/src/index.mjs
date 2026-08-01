import { normalizeRoomId, ZERO_OFFSET } from "@stream-slack/protocol";
import { materializeMessages } from "@stream-slack/reducers";

export function createDurableStreamsStore({
  baseUrl,
  token,
  fetchFn,
  digestRecords,
}) {
  function authHeaders(contentType) {
    return {
      Authorization: `Bearer ${token}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
  }

  function streamUrl(roomId, query = "") {
    const room = encodeURIComponent(normalizeRoomId(roomId));
    return `${baseUrl}/rooms/${room}/messages${query}`;
  }

  async function ensure(roomId) {
    const response = await fetchFn(streamUrl(roomId), {
      method: "PUT",
      headers: authHeaders("application/json"),
      body: "[]",
    });
    if (response.status === 200 || response.status === 201) return;
    throw new Error(
      `Failed to create durable stream for ${roomId}: ${response.status} ${await response.text()}`,
    );
  }

  async function remove(roomId) {
    const response = await fetchFn(streamUrl(roomId), {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (response.status === 204 || response.status === 404) return;
    throw new Error(
      `Failed to delete durable stream for ${roomId}: ${response.status} ${await response.text()}`,
    );
  }

  async function read(roomId, offset = "-1") {
    await ensure(roomId);
    const response = await fetchFn(
      streamUrl(roomId, `?offset=${encodeURIComponent(offset)}`),
      {
        method: "GET",
        headers: authHeaders(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to read durable stream for ${roomId}: ${response.status} ${await response.text()}`,
      );
    }

    const nextOffset =
      response.headers.get("Stream-Next-Offset") ?? ZERO_OFFSET;
    const records = await response.json();
    const normalizedRecords = Array.isArray(records) ? records : [];
    return {
      records: normalizedRecords,
      messages: materializeMessages(normalizedRecords),
      nextOffset,
      streamDigest: digestRecords(normalizedRecords),
    };
  }

  async function append(roomId, record) {
    await ensure(roomId);
    const response = await fetchFn(streamUrl(roomId), {
      method: "POST",
      headers: authHeaders("application/json"),
      body: JSON.stringify(record),
    });
    if (response.status === 200 || response.status === 204) {
      return {
        message: record,
        nextOffset: response.headers.get("Stream-Next-Offset") ?? ZERO_OFFSET,
      };
    }
    throw new Error(
      `Failed to append message to durable stream for ${roomId}: ${response.status} ${await response.text()}`,
    );
  }

  return {
    append,
    ensure,
    read,
    remove,
  };
}
