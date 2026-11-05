/** Write an export bundle to the cache directory and open the share sheet. */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { SessionRepository } from '@/db/SessionRepository';

import { buildExportFiles, buildZip } from './sessionExport';

export async function exportAndShare(repo: SessionRepository, sessionId: string): Promise<string> {
  const zip = buildZip(sessionId, buildExportFiles(repo, sessionId));
  const file = new File(Paths.cache, `${sessionId}.zip`);
  file.create({ overwrite: true });
  await file.write(zip);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/zip',
      dialogTitle: `Export ${sessionId}`,
    });
  }
  return file.uri;
}
