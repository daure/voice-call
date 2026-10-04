export function emptyFileActivity(root = null) {
  return { root, complete: true, calls: [] };
}

export function interruptedFileActivity(activity) {
  const snapshot = structuredClone(activity);
  if (snapshot.root !== null) snapshot.complete = false;
  for (const entry of snapshot.calls) {
    if (entry.status === 'running') {
      entry.status = 'cancelled';
      entry.error = 'Call ended before file tool completion';
    }
  }
  return snapshot;
}

function resultMetadata(tool, output) {
  if (tool === 'glob') return { files: output.files, truncated: output.truncated };
  if (tool === 'grep') return {
    matches: output.matches.map(({ path, line, truncated }) => ({ path, line, truncated })),
    skipped_files: output.skipped_files, truncated: output.truncated,
  };
  const lines = output.lines;
  return { path: output.path, line_ranges: lines.length ? [[lines[0].line, lines.at(-1).line]] : [],
    total_lines: output.total_lines, next_offset: output.next_offset, truncated: output.truncated };
}

export function createFileActivity({ data = emptyFileActivity(), onChange = () => {} } = {}) {
  const deliveries = new Set();
  let stopped = false;
  function put(entry, field, value) {
    entry[field] = value;
    if (Buffer.byteLength(JSON.stringify(data)) > 240_000) {
      delete entry[field];
      entry[`${field}_omitted`] = true;
      data.complete = false;
    }
  }
  return {
    data,
    begin(event, args) {
      if (stopped) return null;
      if (data.calls.length >= 100) { data.complete = false; onChange(); return null; }
      const entry = { sequence: data.calls.length + 1, call_id: event.call_id.slice(0, 200),
        tool: String(event.name).slice(0, 200), status: 'running', delivered_to_voice: false };
      data.calls.push(entry);
      put(entry, 'arguments', args);
      if (Buffer.byteLength(JSON.stringify(data)) > 240_000) {
        data.calls.pop();
        data.complete = false;
        onChange();
        return null;
      }
      onChange();
      return entry;
    },
    finish(entry, output) {
      if (stopped || !entry || entry.status !== 'running') return;
      entry.status = output.error ? 'failed' : 'completed';
      if (output.error) put(entry, 'error', output.error);
      else put(entry, 'result', resultMetadata(entry.tool, output));
      onChange();
    },
    sending(entry) { if (!stopped && entry) deliveries.add(entry); },
    delivered(entry, error) {
      if (stopped || !entry) return;
      deliveries.delete(entry);
      entry.delivered_to_voice = !error;
      if (error) data.complete = false;
      onChange();
    },
    incomplete() { if (!stopped) { data.complete = false; onChange(); } },
    stop() {
      if (stopped) return;
      stopped = true;
      if (deliveries.size) data.complete = false;
      for (const entry of data.calls) {
        if (entry.status === 'running') {
          entry.status = 'cancelled';
          put(entry, 'error', 'File tool stopped before completion');
        }
      }
      deliveries.clear();
      onChange();
    },
  };
}
