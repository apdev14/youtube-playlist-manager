/**
 * delete_playlists.js
 *
 * Fully updated version:
 * - Supports --items=N flag (playlists with exactly N videos)
 * - Supports --before=YYYY flag (playlists created before this year)
 * - Supports --skip="ID1,ID2" to avoid deleting specific playlists
 * - Paginated output for long lists
 * - Manual OAuth flow (no localhost redirect)
 *
 * Usage:
 *   node delete_playlists.js                     # lists all playlists
 *   node delete_playlists.js --items=1          # lists playlists with exactly 1 item
 *   node delete_playlists.js --before=2020      # lists playlists created before 2020
 *   node delete_playlists.js --items=1 --before=2019 --confirm  # deletes playlists with 1 item created before 2019
 *   node delete_playlists.js --filter="Old" --confirm
 *   node delete_playlists.js --ids="ID1,ID2" --confirm
 *   node delete_playlists.js --items=2 --skip="PLAYLIST_ID" --confirm
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];
const CREDENTIALS_PATH = path.join(process.cwd(), 'client_secret.json');
const TOKEN_DIR = path.join(os.homedir(), '.credentials');
const TOKEN_PATH = path.join(TOKEN_DIR, 'youtube-delete-playlists.json');

// Helper function for prompt
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

// Helper function for paginated output
async function pageOutput(items, pageSize = 20) {
  for (let i = 0; i < items.length; i += pageSize) {
    const chunk = items.slice(i, i + pageSize);
    chunk.forEach((p, idx) => {
      console.log(`${i + idx + 1}. ${p.snippet.title} (${p.id}) [items: ${p.contentDetails.itemCount || 0}] [created: ${p.snippet.publishedAt}]`);
    });
    if (i + pageSize < items.length) {
      await ask('\nPress Enter to continue...');
    }
  }
}

// Authorize with Google OAuth
async function authorize() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('Error: client_secret.json not found in current folder.');
    process.exit(1);
  }
  const content = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const client = content.installed || content.web;

  const oauth2Client = new google.auth.OAuth2(
    client.client_id,
    client.client_secret,
    'urn:ietf:wg:oauth:2.0:oob' // manual code copy
  );

  try {
    const token = fs.readFileSync(TOKEN_PATH, 'utf8');
    oauth2Client.setCredentials(JSON.parse(token));
    return oauth2Client;
  } catch (e) {
    const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
    console.log('Authorize this app by visiting this url:\n', authUrl);
    const code = await ask('Enter the code from that page here: ');
    const { tokens } = await oauth2Client.getToken(code.trim());
    oauth2Client.setCredentials(tokens);

    try { fs.mkdirSync(TOKEN_DIR, { recursive: true }); } catch (e) {}
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('Token stored to', TOKEN_PATH);
    return oauth2Client;
  }
}

// Fetch all playlists
async function listAllPlaylists(youtube) {
  const items = [];
  let nextPageToken;
  do {
    const res = await youtube.playlists.list({
      part: 'snippet,contentDetails',
      mine: true,
      maxResults: 50,
      pageToken: nextPageToken
    });
    (res.data.items || []).forEach(i => items.push(i));
    nextPageToken = res.data.nextPageToken;
  } while (nextPageToken);
  return items;
}

// Parse command-line arguments
function parseArgs() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const confirm = argv.includes('--confirm');
  const single = argv.includes('--single');
  const filterArg = argv.find(a => a.startsWith('--filter='));
  const idsArg = argv.find(a => a.startsWith('--ids='));
  const itemsArg = argv.find(a => a.startsWith('--items='));
  const beforeArg = argv.find(a => a.startsWith('--before='));
  const skipArg = argv.find(a => a.startsWith('--skip='));

  const filter = filterArg ? filterArg.split('=')[1] : null;
  const ids = idsArg ? idsArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : null;
  const itemsCount = itemsArg ? parseInt(itemsArg.split('=')[1], 10) : null;
  const beforeYear = beforeArg ? parseInt(beforeArg.split('=')[1], 10) : null;
  const skip = skipArg ? skipArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : [];

  return { all, confirm, filter, ids, single, itemsCount, beforeYear, skip };
}

// Sleep helper
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const args = parseArgs();
  const auth = await authorize();
  const youtube = google.youtube({ version: 'v3', auth });

  console.log('Fetching your playlists (this may take a moment)...');
  const playlists = await listAllPlaylists(youtube);
  if (!playlists.length) {
    console.log('No playlists found on this account.');
    return;
  }

  // Display all playlists
  console.log(`Found ${playlists.length} playlists:\n`);
  playlists.forEach((p, idx) => {
    console.log(`${String(idx+1).padStart(3)}. ${p.snippet.title} (${p.id}) [items: ${p.contentDetails.itemCount || 0}] [created: ${p.snippet.publishedAt}]`);
  });

  // Determine which playlists to delete
  let toDelete = [];
  if (args.itemsCount != null) {
    toDelete = playlists.filter(p => (p.contentDetails.itemCount || 0) === args.itemsCount);
  } else if (args.single) {
    toDelete = playlists.filter(p => (p.contentDetails.itemCount || 0) === 1);
  } else if (args.all) {
    toDelete = playlists.slice();
  } else if (args.ids) {
    const idSet = new Set(args.ids);
    toDelete = playlists.filter(p => idSet.has(p.id));
  } else if (args.filter) {
    let re;
    try { re = new RegExp(args.filter); } catch (e) { console.error('Invalid regex in --filter'); process.exit(1); }
    toDelete = playlists.filter(p => re.test(p.snippet.title));
  }

  // Filter by creation date if --before=YYYY is used
  if (args.beforeYear != null) {
    const cutoff = new Date(`${args.beforeYear}-01-01T00:00:00Z`);
    toDelete = toDelete.filter(p => new Date(p.snippet.publishedAt) < cutoff);
  }

  // Exclude skipped IDs
  if (args.skip.length > 0) {
    const skipSet = new Set(args.skip);
    toDelete = toDelete.filter(p => !skipSet.has(p.id));
  }

  if (!toDelete.length) {
    console.log('\nNo playlists matched your selection. Exiting.');
    return;
  }

  console.log(`\nMatched ${toDelete.length} playlists to delete:`);
  await pageOutput(toDelete);

  if (!args.confirm) {
    console.log('\nSafety: add --confirm to actually delete the above playlists.');
    console.log('Example: node delete_playlists.js --items=2 --before=2019 --skip="PLAYLIST_ID" --confirm');
    return;
  }

  console.log('\nDeleting playlists...');
  for (const p of toDelete) {
    try {
      await youtube.playlists.delete({ id: p.id });
      console.log(`Deleted: ${p.snippet.title} (${p.id})`);
    } catch (err) {
      const msg = (err && err.errors) ? JSON.stringify(err.errors) : (err.message || err);
      console.error(`Failed: ${p.snippet.title} (${p.id}) -> ${msg}`);
    }
    await sleep(350);
  }

  console.log('Done.');
})();
