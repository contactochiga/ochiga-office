export function socialReplyAttempts({ storage, locks, digest, createId }) {
  const terminal = new Set(["provider_accepted", "provider_rejected", "not_sent"]);
  const read = (key) => JSON.parse(storage.getItem(key) || "null");
  return {
    read,
    async prepare(key, text, expectedId) {
      return locks.request(key, async () => {
        const previous = read(key);
        if (expectedId && previous?.id !== expectedId) throw new Error("The previous attempt changed. Refresh the thread before sending.");
        const hash = await digest(text);
        if (previous) {
          if (previous.hash !== hash) throw new Error("Retry with the original reply text. The previous attempt has not been resolved.");
          return previous.id;
        }
        const id = createId();
        storage.setItem(key, JSON.stringify({ id, hash }));
        return id;
      });
    },
    async settle(key, id, state) {
      if (!terminal.has(state)) return false;
      return locks.request(key, () => {
        if (read(key)?.id === id) storage.removeItem(key);
        return true;
      });
    },
  };
}
