import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function assertToken(value) {
  const token = String(value ?? '').trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error('admin token must be 32-byte lowercase hex');
  return token;
}

async function validateExisting(filePath) {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('admin token path must be a regular file');
  const uid = process.getuid?.();
  if (uid != null && stat.uid !== uid) throw new Error('admin token file is owned by another user');
  await chmod(filePath, 0o600);
  return assertToken(await readFile(filePath, 'utf8'));
}

export async function loadOrCreateAdminToken(filePath) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { return await validateExisting(filePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const token = randomBytes(32).toString('hex');
  let handle;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(`${token}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return token;
  } catch (error) {
    try { await handle?.close(); } catch { /* preserve original failure */ }
    if (error.code === 'EEXIST') return validateExisting(filePath);
    throw error;
  }
}

export async function readAdminToken(filePath) {
  return validateExisting(filePath);
}

export function verifyAdminToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
