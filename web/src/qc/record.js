import { queryDocDb } from '../lib/docdb.js';

export async function fetchQcRecord(assetName, { fetchImpl = fetch } = {}) {
  const records = await queryDocDb({ name: assetName }, { limit: 1 });
  if (records.length) return { record: records[0], temporary: false };

  const response = await fetchImpl(`/metadata-viz/temporary-metadata?${new URLSearchParams({ name: assetName })}`, {
    cache: 'no-store',
  });
  if (response.status === 404) throw new Error(`Asset "${assetName}" not found in DocDB or temporary metadata.`);
  if (!response.ok) throw new Error(`Temporary metadata lookup failed (${response.status}).`);
  const envelope = await response.json();
  if (envelope.temporary !== true || envelope.name !== assetName || envelope.metadata?.name !== assetName) {
    throw new Error('Invalid temporary metadata response.');
  }
  return { record: envelope.metadata, temporary: true };
}
