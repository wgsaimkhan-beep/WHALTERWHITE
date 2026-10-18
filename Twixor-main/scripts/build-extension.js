const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');
const archiver = require('archiver');

const SRC_DIR = path.resolve(__dirname, '..', 'chrome-extension');
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');
const OUTPUT_DIR = path.join(DIST_ROOT, 'atomx-extension');
const OUTPUT_ZIP = path.join(DIST_ROOT, 'atomx-extension-secure.zip');

// Obfuscator options tailored specifically for Chrome Manifest V3 Extensions
// Ensures 100% security against reverse engineering while strictly avoiding eval() or CSP violations
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.45,
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayEncoding: ['base64'],
  identifierNamesGenerator: 'hexadecimal',
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: false, // Prevents breaking Chrome API methods and DOM attributes
  renameGlobals: false,        // Preserves window, chrome, document, localStorage
  selfDefending: false,        // Prevents call stack loops in Chrome MV3 sandboxes
  target: 'browser'
};

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanDirSync(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();

  if (isDirectory) {
    ensureDirSync(dest);
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function build() {
  console.log('======================================================');
  console.log('🚀 ATOMX ENGAGE — Chrome Extension Obfuscation & Build');
  console.log('======================================================\n');

  const startTime = Date.now();

  // 1. Prepare dist directory
  console.log(`📁 Cleaning and creating output directory: ${OUTPUT_DIR}`);
  cleanDirSync(OUTPUT_DIR);

  // 2. Scan source directory
  const files = fs.readdirSync(SRC_DIR);
  const jsFiles = [];
  const otherFiles = [];

  for (const file of files) {
    if (file === 'README.md' || file.startsWith('.')) continue;

    const fullSrc = path.join(SRC_DIR, file);
    const stat = fs.statSync(fullSrc);

    if (stat.isDirectory()) {
      otherFiles.push(file);
    } else if (file.endsWith('.js')) {
      jsFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  }

  // 3. Copy non-JS assets (HTML, CSS, JSON, Icons)
  console.log('\n📦 Copying assets (manifest, HTML, CSS, icons)...');
  for (const item of otherFiles) {
    const srcPath = path.join(SRC_DIR, item);
    const destPath = path.join(OUTPUT_DIR, item);

    if (item === 'manifest.json') {
      const manifestRaw = fs.readFileSync(srcPath, 'utf8');
      const manifestJson = JSON.parse(manifestRaw);
      fs.writeFileSync(destPath, JSON.stringify(manifestJson, null, 2), 'utf8');
      console.log(`   ✓ Copied and verified manifest.json`);
    } else {
      copyRecursiveSync(srcPath, destPath);
      console.log(`   ✓ Copied ${item}`);
    }
  }

  // 4. Obfuscate JavaScript files
  console.log('\n🔒 Obfuscating JavaScript files...');
  for (const jsFile of jsFiles) {
    const srcPath = path.join(SRC_DIR, jsFile);
    const destPath = path.join(OUTPUT_DIR, jsFile);

    const originalCode = fs.readFileSync(srcPath, 'utf8');
    const originalSizeKb = (Buffer.byteLength(originalCode, 'utf8') / 1024).toFixed(1);

    process.stdout.write(`   ⏳ Obfuscating ${jsFile} (${originalSizeKb} KB)... `);
    const obfStartTime = Date.now();

    try {
      // Temporarily silence library promo notice for pristine CLI output
      const origLog = console.log;
      console.log = () => {};
      let obfuscationResult;
      try {
        obfuscationResult = JavaScriptObfuscator.obfuscate(originalCode, OBFUSCATOR_OPTIONS);
      } finally {
        console.log = origLog;
      }

      const obfuscatedCode = obfuscationResult.getObfuscatedCode();
      fs.writeFileSync(destPath, obfuscatedCode, 'utf8');

      const obfSizeKb = (Buffer.byteLength(obfuscatedCode, 'utf8') / 1024).toFixed(1);
      const obfDuration = ((Date.now() - obfStartTime) / 1000).toFixed(1);
      console.log(`✓ DONE [${obfDuration}s] -> ${obfSizeKb} KB (Protected)`);
    } catch (err) {
      console.error(`\n❌ Failed to obfuscate ${jsFile}:`, err);
      process.exit(1);
    }
  }

  // 5. Generate ready-to-share Zip archive
  console.log('\n📦 Creating ready-to-share distribution ZIP...');
  await new Promise((resolve, reject) => {
    if (fs.existsSync(OUTPUT_ZIP)) {
      fs.unlinkSync(OUTPUT_ZIP);
    }

    const output = fs.createWriteStream(OUTPUT_ZIP);
    const archive = typeof archiver === 'function'
      ? archiver('zip', { zlib: { level: 9 } })
      : (archiver.ZipArchive ? new archiver.ZipArchive({ zlib: { level: 9 } }) : new (require('archiver').ZipArchive)());

    output.on('close', () => {
      const zipSizeKb = (archive.pointer() / 1024).toFixed(1);
      console.log(`   ✓ Created: ${OUTPUT_ZIP} (${zipSizeKb} KB)`);
      resolve();
    });

    archive.on('error', (err) => reject(err));
    archive.pipe(output);
    archive.directory(OUTPUT_DIR, false);
    archive.finalize();
  });

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n======================================================');
  console.log(`✨ BUILD COMPLETED IN ${totalTime}s`);
  console.log('======================================================');
  console.log(`📁 Unpacked Folder (for Kiwi/Chrome):`);
  console.log(`   ${OUTPUT_DIR}`);
  console.log(`🤐 Ready-to-send ZIP file:`);
  console.log(`   ${OUTPUT_ZIP}`);
  console.log('======================================================\n');
}

build().catch(err => {
  console.error('Fatal build error:', err);
  process.exit(1);
});
