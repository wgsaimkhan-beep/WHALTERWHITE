/**
 * AtomX - Google Sheet / CSV Target Importer (Admin Controlled)
 * 
 * Supports CSV/TSV with columns:
 * Rank | X Username | X Profile Link | Sorsa Score | Wallchain Score | Tier
 * 
 * Usage:
 *   node scripts/importSheet.js path/to/sheet.csv [options]
 * 
 * Options:
 *   --name="List Name"           Title of the list (e.g. "Sorsa Mid-Tier Alpha")
 *   --agent="sorsa|audience|followers" Target agent (default: "sorsa")
 *   --from-rank=21               Start rank range (e.g. 21)
 *   --to-rank=99                 End rank range (e.g. 99)
 *   --access="free|paid"         User plan required (default: "free")
 *   --status="published|draft"   Visibility in extension (default: "published")
 *   --limit=100                  How many IDs to insert (default: all matching)
 *   --tier="tier1|tier2|all"     Filter by tier column (default: "all")
 */

const fs = require('fs');
const path = require('path');

const curatedPath = path.join(__dirname, '../backend/data/curatedLists.json');

function parseDelimitedText(content) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('File has no data rows.');
  }

  const headerLine = lines[0];
  let delimiter = ',';
  if (headerLine.includes('\t')) delimiter = '\t';
  else if (headerLine.includes(';') && !headerLine.includes(',')) delimiter = ';';

  function splitLine(line) {
    if (delimiter === '\t') return line.split('\t').map(c => c.trim().replace(/^["']|["']$/g, ''));
    const pattern = new RegExp(`(?:^|${delimiter})(?:"([^"]*)"|([^"${delimiter}]*))`, 'g');
    const result = [];
    let match;
    while ((match = pattern.exec(line)) !== null) {
      result.push((match[1] !== undefined ? match[1] : match[2] || '').trim());
      if (pattern.lastIndex === 0 && line.length > 0) break;
    }
    return result;
  }

  const headers = splitLine(headerLine).map(h => h.toLowerCase());
  const usernameIdx = headers.findIndex(h => h.includes('username') || h.includes('handle') || h === 'x username');
  const linkIdx = headers.findIndex(h => h.includes('profile') || h.includes('link') || h.includes('url'));
  const tierIdx = headers.findIndex(h => h.includes('tier'));
  const sorsaIdx = headers.findIndex(h => h.includes('sorsa'));
  const rankIdx = headers.findIndex(h => h.includes('rank'));

  const parsedUsers = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    if (!cols || cols.length === 0 || cols.every(c => !c)) continue;

    let handle = '';
    if (usernameIdx !== -1 && cols[usernameIdx]) {
      handle = cols[usernameIdx].trim();
    }
    if (!handle && linkIdx !== -1 && cols[linkIdx]) {
      const match = cols[linkIdx].match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,25})/);
      if (match) handle = match[1];
    }
    if (!handle) continue;

    handle = handle.replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9_]{1,25}$/.test(handle)) continue;

    const tier = (tierIdx !== -1 && cols[tierIdx]) ? cols[tierIdx].trim() : 'Tier 1';
    const sorsaScore = (sorsaIdx !== -1 && cols[sorsaIdx]) ? cols[sorsaIdx].trim() : '';
    const rawRank = (rankIdx !== -1 && cols[rankIdx]) ? cols[rankIdx].trim() : i.toString();
    const rankNum = parseInt(rawRank.replace(/[^0-9]/g, ''), 10) || i;

    parsedUsers.push({
      handle: '@' + handle,
      tier,
      sorsaScore,
      rank: rankNum
    });
  }

  return parsedUsers;
}

function getCliArg(prefix, fallback = '') {
  const arg = process.argv.find(a => a.startsWith(prefix));
  if (!arg) return fallback;
  return arg.split('=')[1] ? arg.split('=')[1].replace(/^["']|["']$/g, '') : fallback;
}

function importSheet(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`📄 Reading ${filePath}...`);
  const content = fs.readFileSync(filePath, 'utf8');
  const allUsers = parseDelimitedText(content);
  console.log(`✓ Parsed ${allUsers.length} total rows from sheet.`);

  // Admin Decisions via CLI flags
  const tierFilter = getCliArg('--tier', 'all').toLowerCase();
  const limitArg = parseInt(getCliArg('--limit', '0'), 10);
  const fromRank = parseInt(getCliArg('--from-rank', '0'), 10);
  const toRank = parseInt(getCliArg('--to-rank', '0'), 10);

  const rawAgent = getCliArg('--agent', 'sorsa').toLowerCase();
  let targetAgent = 'Score Accelerator';
  if (rawAgent.includes('aud') || rawAgent.includes('crowd')) targetAgent = 'CrowdFi';
  else if (rawAgent.includes('follow') || rawAgent.includes('growth')) targetAgent = 'GrowthFi';

  const rawAccess = getCliArg('--access', 'free').toLowerCase();
  const targetAccess = rawAccess.includes('paid') || rawAccess.includes('pro') ? 'paid' : 'free';

  const rawStatus = getCliArg('--status', 'published').toLowerCase();
  const targetStatus = rawStatus.includes('draft') ? 'draft' : 'published';

  let filtered = allUsers;
  let rangeLabel = 'All Ranks';

  // Rank Range Filter (e.g. 21 to 99, 550 to 1000)
  if (fromRank > 0 && toRank >= fromRank) {
    rangeLabel = `Rank ${fromRank}–${toRank}`;
    filtered = filtered.filter(u => u.rank >= fromRank && u.rank <= toRank);
  }

  if (tierFilter !== 'all') {
    filtered = filtered.filter(u => u.tier.toLowerCase().includes(tierFilter));
  }

  const limit = limitArg > 0 ? limitArg : filtered.length;
  const selectedHandles = filtered.slice(0, limit).map(u => u.handle);
  const listName = getCliArg('--name', `Imported ${targetAgent} (${rangeLabel})`);

  console.log(`\n⚙️ Admin Configuration Applied:`);
  console.log(`   - List Name: "${listName}"`);
  console.log(`   - Assigned Agent: ${targetAgent}`);
  console.log(`   - Access Plan: ${targetAccess.toUpperCase()}`);
  console.log(`   - Visibility: ${targetStatus.toUpperCase()}`);
  console.log(`   - Rank Range: ${rangeLabel}`);
  console.log(`   - Filter: Tier=${tierFilter}`);
  console.log(`   - Total IDs Selected: ${selectedHandles.length} of ${allUsers.length}`);

  let curated = {};
  if (fs.existsSync(curatedPath)) {
    try {
      curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));
    } catch (e) {
      curated = {};
    }
  }

  const listKey = 'custom_' + Date.now();
  curated[listKey] = {
    id: listKey,
    name: listName,
    category: targetAgent,
    status: targetStatus,
    accessTier: targetAccess,
    rankRange: rangeLabel,
    description: `Admin imported list with ${selectedHandles.length} accounts (${rangeLabel}).`,
    listUrl: '',
    targets: selectedHandles
  };

  fs.mkdirSync(path.dirname(curatedPath), { recursive: true });
  fs.writeFileSync(curatedPath, JSON.stringify(curated, null, 2), 'utf8');

  console.log(`\n🎉 SUCCESS: Created "${listName}" in curatedLists.json!`);
  console.log(`========================================\n`);
}

const targetFile = process.argv[2];
if (!targetFile || targetFile.startsWith('--')) {
  console.log(`\nℹ️ Usage: node scripts/importSheet.js <path-to-csv> [options]`);
  console.log(`Options:`);
  console.log(`  --name="Custom List Name"`);
  console.log(`  --agent="sorsa" OR --agent="audience" OR --agent="followers"`);
  console.log(`  --from-rank=21 --to-rank=99`);
  console.log(`  --access="free" OR --access="paid"`);
  console.log(`  --status="published" OR --status="draft"`);
  console.log(`  --limit=100 (optional limit)`);
  console.log(`  --tier="tier1" OR --tier="tier2" OR --tier="all"`);
  console.log(`\nExamples:`);
  console.log(`  node scripts/importSheet.js sheet.csv --name="Sorsa KOLs (21-99)" --agent="sorsa" --from-rank=21 --to-rank=99 --access="paid" --status="published"`);
  console.log(`  node scripts/importSheet.js sheet.csv --name="Audience (550-1000)" --agent="audience" --from-rank=550 --to-rank=1000 --access="free" --status="published"\n`);
  process.exit(0);
}

importSheet(targetFile);
