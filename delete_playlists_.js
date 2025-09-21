/**
 * delete_playlists.js
 *
 * Updated version: supports --single flag (playlists with only 1 video)
 * Manual OAuth flow (no localhost redirect)
 *
 * Usage:
 *   node delete_playlists.js                  # lists all playlists
 *   node delete_playlists.js --single        # lists playlists with 1 item
 *   node delete_playlists.js --single --confirm  # deletes playlists with 1 item
 *   node delete_playlists.js --filter="Old" --confirm
 *   node delete_playlists.js --ids="ID1,ID2" --confirm
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

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

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
    'urn:ietf:wg:oauth:2.0:oob' // forces manual code copy
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

function parseArgs() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const confirm = argv.includes('--confirm');
  const single = argv.includes('--single'); // new flag
  const filterArg = argv.find(a => a.startsWith('--filter='));
  const idsArg = argv.find(a => a.startsWith('--ids='));
  const filter = filterArg ? filterArg.split('=')[1] : null;
  const ids = idsArg ? idsArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : null;
  return { all, confirm, filter, ids, single };
}

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

  // Display all playlists first
  console.log(`Found ${playlists.length} playlists:\n`);
  playlists.forEach((p, idx) => {
    console.log(`${String(idx+1).padStart(3)}. ${p.snippet.title}  (id: ${p.id})  [items: ${p.contentDetails.itemCount || 0}]`);
  });

  // Determine which playlists to delete
  let toDelete = [];
  if (args.single) {
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

  if (!toDelete.length) {
    console.log('\nNo playlists matched your selection. Exiting.');
    return;
  }

  console.log(`\nMatched ${toDelete.length} playlists to delete (first 10 shown):`);
  toDelete.slice(0,10).forEach(p => console.log(` - ${p.snippet.title} (${p.id}) [items: ${p.contentDetails.itemCount || 0}]`));

  if (!args.confirm) {
    console.log('\nSafety: add --confirm to actually delete the above playlists.');
    console.log('Example: node delete_playlists.js --single --confirm');
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
    await sleep(350); // small delay to avoid hammering the API
  }

  console.log('Done.');
})();
