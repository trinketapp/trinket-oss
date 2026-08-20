var childProcess = require('child_process');

// adm-zip@0.4.x (the version pinned in package.json — also used for the
// unrelated course/trinket-archive import feature, so not something this
// port should bump) only trusts a zip entry's Local File Header size/CRC
// fields. archiver's streamed output (this repo's archiver@^2.0.0, used by
// both processBulkExport and this feature's createSubmissionsArchive) writes
// those as placeholders and appends the real size/CRC in a trailing data
// descriptor per the Zip spec — perfectly valid, and every modern zip tool
// (Finder, Explorer, 7-Zip, a current unzip binary) reads it correctly. Only
// the old adm-zip reader is fooled, reporting every entry as empty.
// Read through the system `unzip` CLI instead so these tests exercise the
// real, spec-compliant archive real users would receive rather than a false
// negative from the outdated reader.
function run(args) {
  try {
    return childProcess.execFileSync('unzip', args, { encoding: 'utf8' });
  } catch (err) {
    // unzip exits non-zero (e.g. 2 = warning-not-error) even on a successful
    // read when it also emits a CRC/size mismatch warning against the
    // (placeholder) local header — see the comment above. Whatever it wrote
    // to stdout before that is still the real content.
    if (typeof err.stdout === 'string') return err.stdout;
    if (Buffer.isBuffer(err.stdout)) return err.stdout.toString('utf8');
    throw err;
  }
}

function listEntries(zipPath) {
  var out = run(['-Z1', zipPath]);
  return out.split('\n').filter(function(line) { return line.length > 0; });
}

function readAsText(zipPath, entryName) {
  return run(['-p', zipPath, entryName]);
}

module.exports = {
  listEntries: listEntries,
  readAsText: readAsText
};
