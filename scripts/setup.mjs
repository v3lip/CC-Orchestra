// Creates .env with a random admin password if it does not exist yet.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (existsSync('.env')) {
  console.log('.env already exists; leaving it unchanged.');
} else {
  const pw = randomBytes(12).toString('base64url');
  const text = readFileSync('.env.example', 'utf8').replace('ADMIN_PASSWORD=change-me', `ADMIN_PASSWORD=${pw}`);
  writeFileSync('.env', text);
  console.log(`Created .env. Dashboard password: ${pw}`);
}
