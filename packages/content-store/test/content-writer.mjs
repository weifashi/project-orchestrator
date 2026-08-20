/* global Buffer, process */
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../../sqlite-store/dist/index.js';
import { ContentStore } from '../dist/index.js';

const [, , databasePath, objectsRoot, readyPath, goPath] = process.argv;
if (databasePath === undefined || objectsRoot === undefined || readyPath === undefined || goPath === undefined) {
  throw new Error('writer arguments missing');
}

const db = openDatabase(databasePath);
const store = new ContentStore(objectsRoot, db);
writeFileSync(readyPath, 'ready');
while (!existsSync(goPath)) await delay(5);
const object = store.putBytes(Buffer.alloc(8 * 1024 * 1024, 7), 'application/octet-stream');
process.stdout.write(object.id);
db.close();
